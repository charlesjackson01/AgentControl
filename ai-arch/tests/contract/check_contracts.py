#!/usr/bin/env python3
"""check_contracts.py — diff dbus/*.xml against the live bus (T3).

dbus/ XML is the source of truth; every property/method/signal declared for
an implemented interface must exist on the running service with a matching
D-Bus signature. Drift fails.

Usage: python3 check_contracts.py [--service org.aiarch.Config --path /org/aiarch/Config]...
Defaults: org.aiarch.Config + org.aiarch.AI (the Stage D implemented pair).
Exit: 0 = no drift, 1 = drift, 2 = service not reachable.
"""
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DBUS_DIR = ROOT / "dbus"

DEFAULTS = [
    ("org.aiarch.Config", "/org/aiarch/Config"),
    ("org.aiarch.AI", "/org/aiarch/AI"),
]


def parse_xml(iface_name):
    xml = DBUS_DIR / (iface_name + ".xml")
    tree = ET.parse(xml)
    iface = None
    for node in tree.iter("interface"):
        if node.get("name") == iface_name:
            iface = node
            break
    if iface is None:
        raise SystemExit("check_contracts: interface %s not found in %s" % (iface_name, xml))

    props = {}
    for p in iface.findall("property"):
        props[p.get("name")] = p.get("type")

    methods = {}
    for m in iface.findall("method"):
        insig = "".join(a.get("type") for a in m.findall("arg") if a.get("direction", "in") == "in")
        outsig = "".join(a.get("type") for a in m.findall("arg") if a.get("direction") == "out")
        methods[m.get("name")] = insig + outsig

    signals = {}
    for s in iface.findall("signal"):
        signals[s.get("name")] = "".join(a.get("type") for a in s.findall("arg"))

    return props, methods, signals


def introspect(service, path):
    try:
        out = subprocess.run(
            ["busctl", "--user", "introspect", service, path],
            capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        print("check_contracts: busctl not available", file=sys.stderr)
        sys.exit(2)
    if out.returncode != 0:
        print("check_contracts: %s not reachable: %s" % (service, out.stderr.strip()), file=sys.stderr)
        sys.exit(2)

    props, methods, signals = {}, {}, {}
    for line in out.stdout.splitlines():
        line = line.strip()
        if line.startswith("property "):
            # property <type> <name> <value>;
            parts = line.rstrip(";").split(None, 2)
            if len(parts) >= 3:
                props[parts[2]] = parts[1]
        elif line.startswith("method "):
            # method <name>(<sig>);
            rest = line[len("method "):].rstrip(";")
            name, _, sig = rest.partition("(")
            methods[name] = sig.rstrip(")").strip()
        elif line.startswith("signal "):
            rest = line[len("signal "):].rstrip(";")
            name, _, sig = rest.partition("(")
            signals[name] = sig.rstrip(")").strip()
    return props, methods, signals


def diff(iface, xml, bus):
    problems = []
    for kind, xml_map, bus_map in (("property", xml[0], bus[0]),
                                   ("method", xml[1], bus[1]),
                                   ("signal", xml[2], bus[2])):
        for name, sig in xml_map.items():
            if name not in bus_map:
                problems.append("%s %s.%s missing on bus" % (kind, iface, name))
            elif bus_map[name] != sig:
                problems.append(
                    "%s %s.%s signature drift: xml=%s bus=%s"
                    % (kind, iface, name, sig, bus_map[name])
                )
    return problems


def main():
    targets = list(DEFAULTS)
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--service" and i + 3 < len(args):
            targets.append((args[i + 1], args[i + 3]))
            i += 4
            continue
        i += 1

    all_ok = True
    for service, path in targets:
        iface = service  # org.aiarch.<Name>
        try:
            xml = parse_xml(iface)
        except SystemExit as e:
            print(e, file=sys.stderr)
            return 2
        bus = introspect(service, path)
        problems = diff(iface, xml, bus)
        if problems:
            all_ok = False
            for p in problems:
                print("DRIFT:", p, file=sys.stderr)
        else:
            print("contract ok: %s (%d props, %d methods, %d signals)"
                  % (iface, len(xml[0]), len(xml[1]), len(xml[2])))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
