#!/usr/bin/env python3
"""M0 spike: how fast does an ai-arch VM boot now that KVM works?

Boots a THROWAWAY copy of an ai-arch baseline disk under KVM, measures the time
to a DHCP address and to an SSH banner, then removes everything it created.
It never modifies, starts, or stops your existing VMs or baseline images:
  * the baseline is used read-only as the backing file of a new qcow2 overlay
  * a new libvirt domain (default name ac-kvm-probe) is defined from a copy of
    the source domain's XML, with domain type='kvm' and CPU host-passthrough
  * on exit the probe domain is destroyed, undefined, and its overlay and NVRAM
    copy are deleted

Dry run (default) only prints what it would do:
    python3 kvm_boot_probe.py --baseline ~/AgentControl/ai-arch/vms/ai-arch-baseline-with-theme.qcow2
Actually boot it:
    python3 kvm_boot_probe.py --baseline ... --run

Needs: virsh + qemu-img, and your user in the libvirt group (qemu:///system).
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

URI = 'qemu:///system'


def virsh(*args, check=True):
    result = subprocess.run(['virsh', '-c', URI, *args], capture_output=True, text=True, timeout=120)
    if check and result.returncode:
        raise RuntimeError(f'virsh {" ".join(args)} failed: {result.stderr.strip() or result.stdout.strip()}')
    return result.stdout


def domain_exists(name):
    return subprocess.run(['virsh', '-c', URI, 'dominfo', name], capture_output=True, timeout=30).returncode == 0


def relocate(path, vm_dir):
    """If a firmware file is missing (e.g. the ai-arch folder moved), look for it in vm_dir."""
    if path and not Path(path).exists() and vm_dir:
        candidate = Path(vm_dir).expanduser() / Path(path).name
        if candidate.exists():
            return str(candidate)
    return path


def probe_xml(source_xml, name, overlay, nvram_dir, vm_dir=None):
    """Turn the source domain XML into a throwaway KVM domain definition."""
    root = ET.fromstring(source_xml)
    root.set('type', 'kvm')
    root.attrib.pop('id', None)
    root.find('name').text = name
    for tag in ('uuid', 'title', 'description'):
        node = root.find(tag)
        if node is not None:
            root.remove(node)
    cpu = root.find('cpu')
    if cpu is not None:
        root.remove(cpu)
    ET.SubElement(root, 'cpu', {'mode': 'host-passthrough', 'check': 'none'})
    notes = []
    nvram = root.find('os/nvram')
    if nvram is not None:
        # libvirt copies the template on first start; start from the source VM's vars so boot entries survive.
        source_vars = relocate((nvram.text or '').strip(), vm_dir)
        template = source_vars if source_vars and Path(source_vars).exists() else nvram.get('template', '')
        if not template or not Path(template).exists():
            notes.append(f'NVRAM template not found ({source_vars or template}); the firmware may need to fall back to EFI/BOOT/BOOTX64.EFI')
        nvram.set('template', template)
        nvram.text = str(Path(nvram_dir) / f'{name}_VARS.fd')
    loader = root.find('os/loader')
    if loader is not None and loader.text:
        loader.text = relocate(loader.text.strip(), vm_dir)
    if loader is not None and loader.text and not Path(loader.text.strip()).exists():
        notes.append(f'Firmware file missing: {loader.text.strip()} (did the ai-arch folder move?)')
    devices = root.find('devices')
    kept_disk = False
    for disk in list(devices.findall('disk')):
        if disk.get('device') == 'disk' and not kept_disk:
            source = disk.find('source')
            source.attrib.clear()
            source.set('file', str(overlay))
            backing = disk.find('backingStore')
            if backing is not None:
                disk.remove(backing)
            for alias in disk.findall('alias'):
                disk.remove(alias)
            kept_disk = True
        else:
            devices.remove(disk)  # CD-ROMs, seed ISOs, data disks: not needed to measure boot
    for iface in devices.findall('interface'):
        for child in list(iface):
            if child.tag in ('mac', 'target', 'alias'):
                iface.remove(child)
        source = iface.find('source')
        if source is not None:
            for attr in ('portid', 'bridge'):
                source.attrib.pop(attr, None)
    for node in devices.iter():
        for child in list(node):
            if child.tag == 'alias':
                node.remove(child)
    for tag in ('serial', 'console'):
        for node in devices.findall(tag):
            source = node.find('source')
            if source is not None:
                node.remove(source)
            node.attrib.pop('tty', None)
    for seclabel in root.findall('seclabel'):
        root.remove(seclabel)
    return ET.tostring(root, encoding='unicode'), notes


def lease_ip(name):
    out = virsh('domifaddr', name, '--source', 'lease', check=False)
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[2] == 'ipv4':
            return parts[3].split('/')[0]
    return None


def ssh_banner(ip):
    try:
        with socket.create_connection((ip, 22), timeout=2) as s:
            s.settimeout(3)
            return s.recv(64).decode(errors='replace').strip()
    except OSError:
        return None


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--source-domain', default='ai-arch-dev', help='existing domain whose XML is copied (never modified)')
    p.add_argument('--baseline', required=True, help='baseline qcow2 used read-only as the backing file')
    p.add_argument('--name', default='ac-kvm-probe')
    p.add_argument('--timeout', type=int, default=600)
    p.add_argument('--vm-dir', help='where the ai-arch VM firmware files live now, if the folder moved '
                                    '(e.g. ~/AgentControl/ai-arch/vms)')
    p.add_argument('--run', action='store_true', help='actually define, boot, measure, and clean up')
    a = p.parse_args()

    for tool in ('virsh', 'qemu-img'):
        if not shutil.which(tool):
            sys.exit(f'{tool} is not installed')
    baseline = Path(a.baseline).expanduser().resolve()
    if not baseline.is_file():
        sys.exit(f'Baseline not found: {baseline}')
    if domain_exists(a.name):
        sys.exit(f'A domain named {a.name} already exists; refusing to touch it. Choose another --name.')
    state = virsh('domstate', a.source_domain).strip()
    source_xml = virsh('dumpxml', '--inactive', a.source_domain)
    source_disk = ET.fromstring(source_xml).find("devices/disk[@device='disk']/source")
    if source_disk is not None and Path(source_disk.get('file', '')).resolve() == baseline and state != 'shut off':
        sys.exit('The baseline is the running disk of the source VM. Use a cold baseline copy (vms/ai-arch-baseline-*.qcow2).')

    workdir = baseline.parent
    overlay = workdir / f'{a.name}-overlay.qcow2'
    plan_xml, notes = probe_xml(source_xml, a.name, overlay, workdir, a.vm_dir)
    print(f'source domain: {a.source_domain} ({state}); baseline (read-only): {baseline}')
    print(f'probe domain: {a.name}; overlay: {overlay}; KVM device: {"present" if Path("/dev/kvm").exists() else "MISSING"}')
    for note in notes:
        print('note:', note)
    if not a.run:
        print('\nDry run. Probe domain XML:\n' + plan_xml + '\n\nRe-run with --run to boot it.')
        return

    report = {'baseline': str(baseline), 'domain_type': 'kvm', 'notes': notes}
    defined = False
    try:
        subprocess.run(['qemu-img', 'create', '-q', '-f', 'qcow2', '-b', str(baseline), '-F', 'qcow2', str(overlay)], check=True)
        with tempfile.NamedTemporaryFile('w', suffix='.xml', delete=False) as f:
            f.write(plan_xml)
        virsh('define', f.name)
        os.unlink(f.name)
        defined = True
        start = time.monotonic()
        virsh('start', a.name)
        ip = banner = None
        while time.monotonic() - start < a.timeout:
            if not ip:
                ip = lease_ip(a.name)
                if ip:
                    report['seconds_to_dhcp_address'] = round(time.monotonic() - start, 1)
                    report['ip'] = ip
            if ip:
                banner = ssh_banner(ip)
                if banner:
                    report['seconds_to_ssh_banner'] = round(time.monotonic() - start, 1)
                    report['ssh_banner'] = banner
                    break
            time.sleep(1)
        else:
            report['timed_out_after_seconds'] = a.timeout
    finally:
        if defined:
            virsh('destroy', a.name, check=False)
            virsh('undefine', a.name, '--nvram', check=False)
        overlay.unlink(missing_ok=True)
        report['cleaned_up'] = not domain_exists(a.name) and not overlay.exists()
    print(json.dumps(report, indent=2))
    print('\nFor comparison, ai-arch documents TCG boots as "30-60 s to network" and says never to call a TCG VM down before 2 minutes.')


if __name__ == '__main__':
    main()
