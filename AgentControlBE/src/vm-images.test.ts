/**
 * BE-P2-3: static checks on the shared bot images. A real build (python3, node and
 * chromium as uid 1000) is the `@vm` test at the bottom, skipped unless AC_VM_TESTS=1
 * and an engine is installed; until Podman is on a CI runner these are the gate.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BOTVM_PINS,
  BOT_PATHS,
  IMAGE_LABELS,
  PLAYWRIGHT_BROWSERS_PATH,
  BROWSER_LAUNCH_NOTE,
  CHROMIUM_LAUNCH_OPTIONS,
  SHARED_IMAGE_KINDS,
  baseImageFor,
  botContainerName,
  botImageRef,
  botLayerContainerfile,
  botOptVolume,
  botToolsVolume,
  containerfilePath,
  imageBuildArgv,
  egressdNftBuildArgv,
  egressdNftImageRef,
  sharedImageRef,
  sharedImagesToBuild,
  vmDir,
  type SharedImageKind,
} from './vm-images.js'

interface Instr {
  op: string
  args: string
}

/** Containerfile → instructions (comments dropped, `\` continuations joined). */
function parse(text: string): Instr[] {
  const out: Instr[] = []
  let buf = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!buf && (line === '' || line.startsWith('#'))) continue
    if (line.startsWith('#')) continue
    if (line.endsWith('\\')) {
      buf += line.slice(0, -1) + ' '
      continue
    }
    buf += line
    const m = /^(\w+)\s+([\s\S]*)$/.exec(buf.trim())
    if (m) out.push({ op: m[1]!.toUpperCase(), args: m[2]!.trim() })
    buf = ''
  }
  return out
}

const files = Object.fromEntries(SHARED_IMAGE_KINDS.map((k) => [k, readFileSync(containerfilePath(k), 'utf8')])) as Record<SharedImageKind, string>
const instrs = Object.fromEntries(SHARED_IMAGE_KINDS.map((k) => [k, parse(files[k])])) as Record<SharedImageKind, Instr[]>
const of = (k: SharedImageKind, op: string) => instrs[k].filter((i) => i.op === op)

/** ARG NAME=default → { NAME: default } */
function argDefaults(k: SharedImageKind): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of of(k, 'ARG')) {
    const m = /^([A-Z0-9_]+)(?:=(.*))?$/.exec(i.args)
    if (m && m[2] !== undefined) out[m[1]!] = m[2]
  }
  return out
}

/** ENV/LABEL key=value pairs (quoted values allowed). */
function pairs(k: SharedImageKind, op: 'ENV' | 'LABEL'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of of(k, op)) {
    for (const m of i.args.matchAll(/([\w.-]+)=("([^"]*)"|\S+)/g)) out[m[1]!] = m[3] ?? m[2]!
  }
  return out
}

function versionsEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path.join(vmDir(), 'images', 'versions.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

describe('pinned versions', () => {
  it('versions.env, BOTVM_PINS and the Containerfile ARG defaults agree', () => {
    expect(versionsEnv()).toEqual(BOTVM_PINS)
    for (const k of SHARED_IMAGE_KINDS) {
      for (const [name, value] of Object.entries(argDefaults(k))) {
        if (name === 'BOTVM_IMAGE') expect(value).toBe(sharedImageRef('botvm'))
        else expect(value, `${k} ARG ${name}`).toBe(BOTVM_PINS[name as keyof typeof BOTVM_PINS])
      }
    }
  })

  it('the base is Debian slim with Python 3.12, pinned by digest; Node 22 is checksum-pinned per arch', () => {
    expect(BOTVM_PINS.BASE_IMAGE).toMatch(/^docker\.io\/library\/python:3\.12\.\d+-slim-bookworm@sha256:[0-9a-f]{64}$/)
    expect(BOTVM_PINS.BASE_IMAGE).toContain(`python:${BOTVM_PINS.PYTHON_VERSION}-`)
    expect(BOTVM_PINS.NODE_VERSION).toMatch(/^22\.\d+\.\d+$/)
    expect(BOTVM_PINS.NODE_SHA256_X64).toMatch(/^[0-9a-f]{64}$/)
    expect(BOTVM_PINS.NODE_SHA256_ARM64).toMatch(/^[0-9a-f]{64}$/)
    expect(BOTVM_PINS.PLAYWRIGHT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    expect(of('botvm', 'FROM').map((i) => i.args)).toEqual(['${BASE_IMAGE}'])
    expect(of('botvm-browser', 'FROM').map((i) => i.args)).toEqual(['${BOTVM_IMAGE}'])
    const nodeRun = of('botvm', 'RUN').find((i) => i.args.includes('nodejs.org/dist'))!
    expect(nodeRun.args).toContain('sha256sum -c')
    expect(nodeRun.args).toContain('${NODE_SHA256_X64}')
    expect(nodeRun.args).toContain('${NODE_SHA256_ARM64}')
    expect(nodeRun.args).toMatch(/curl -fsSL/)
  })
})

describe.each(SHARED_IMAGE_KINDS)('%s Containerfile', (kind) => {
  it('ends as the non-root bot user (uid 1000), with root only for install steps', () => {
    const users = of(kind, 'USER').map((i) => i.args)
    expect(users.at(-1)).toBe('1000:1000')
    for (const u of users) expect(['root', '1000:1000']).toContain(u)
    // Nothing runs after the final USER except metadata.
    const lastUser = instrs[kind].findLastIndex((i) => i.op === 'USER')
    expect(instrs[kind].slice(lastUser + 1).map((i) => i.op).filter((op) => op === 'RUN')).toEqual([])
  })

  it('carries the AgentControl and OCI labels with the pinned version', () => {
    const labels = pairs(kind, 'LABEL')
    expect(labels[IMAGE_LABELS.image]).toBe(kind)
    expect(labels[IMAGE_LABELS.version]).toBe('${BOTVM_VERSION}')
    expect(labels['org.opencontainers.image.version']).toBe('${BOTVM_VERSION}')
    expect(labels['org.opencontainers.image.title']).toBe(`agentcontrol/${kind}`)
  })

  it('has no secrets, remote ADDs, privileged bits, exposed ports or sudo', () => {
    const text = files[kind]
    for (const i of [...of(kind, 'ARG'), ...of(kind, 'ENV')]) {
      for (const name of i.args.match(/\b[A-Z][A-Z0-9_]+(?==)/g) ?? []) {
        if (/^NODE_SHA256_/.test(name)) continue
        expect(name, `${kind}: ${i.op} ${name}`).not.toMatch(/TOKEN|SECRET|PASSW|API_?KEY|CREDENTIAL|AUTH/)
      }
    }
    expect(text).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY/)
    expect(of(kind, 'ADD')).toEqual([])
    // The only COPY is the browser layer's own link script from its build context (no --from, no secrets).
    expect(of(kind, 'COPY').map((i) => i.args)).toEqual(kind === 'botvm-browser' ? ['link-headless-shell.sh /usr/local/lib/agentcontrol/link-headless-shell.sh'] : [])
    expect(of(kind, 'EXPOSE')).toEqual([])
    expect(of(kind, 'VOLUME')).toEqual([])
    const body = instrs[kind].map((i) => `${i.op} ${i.args}`).join('\n')
    expect(body).not.toMatch(/\bsudo\b|--privileged|chmod [0-7]*7{3}|setuid|chmod u\+s/)
    expect(body).not.toMatch(/HTTPS?_PROXY|NO_PROXY/)
  })

  it('cleans apt lists in every RUN that installs packages', () => {
    for (const r of of(kind, 'RUN').filter((i) => /apt-get install|--with-deps/.test(i.args))) {
      expect(r.args).toContain('rm -rf /var/lib/apt/lists/*')
    }
  })

  it('works in /bot/workspace and idles under tini (runs arrive via exec)', () => {
    expect(of(kind, 'WORKDIR').at(-1)?.args).toBe(BOT_PATHS.workspace)
    expect(of(kind, 'ENTRYPOINT').at(-1)?.args).toBe('["/usr/bin/tini", "--"]')
    expect(of(kind, 'CMD').at(-1)?.args).toBe('["sleep", "infinity"]')
  })
})

describe('botvm base layout', () => {
  it('creates the bot user as uid/gid 1000 with /home/bot', () => {
    const run = of('botvm', 'RUN').find((i) => i.args.includes('useradd'))!
    expect(run.args).toMatch(/groupadd --gid 1000 bot/)
    expect(run.args).toMatch(/useradd --uid 1000 --gid 1000 --home-dir \/home\/bot/)
  })

  it('creates the /bot layout and the tool dirs, owned by the bot where writable', () => {
    const run = of('botvm', 'RUN').find((i) => i.args.includes('mkdir -p /bot/workspace'))!
    for (const p of [BOT_PATHS.workspace, BOT_PATHS.inputs, BOT_PATHS.skills, BOT_PATHS.groups, BOT_PATHS.optBin, `${BOT_PATHS.home}/.local/bin`]) {
      expect(run.args).toContain(p)
    }
    expect(run.args).toMatch(/chown -R 1000:1000 \/bot\/workspace \/bot\/groups \/opt\/bot \/home\/bot/)
    // Read-only mounts stay root-owned.
    expect(run.args).not.toMatch(/chown[^&]*\/bot\/(shared|skills)/)
  })

  it('sets HOME, PATH (~/.local/bin and /opt/bot/bin first) and user-level pip/npm into the tools volume', () => {
    const env = pairs('botvm', 'ENV')
    expect(env.HOME).toBe(BOT_PATHS.home)
    expect(env.PATH!.split(':').slice(0, 2)).toEqual(['/home/bot/.local/bin', BOT_PATHS.optBin])
    expect(env.PIP_USER).toBe('1')
    expect(env.PYTHONUSERBASE).toBe('/home/bot/.local')
    expect(env.NPM_CONFIG_PREFIX).toBe('/home/bot/.local')
    expect(env.NODE_PATH).toBe('/home/bot/.local/lib/node_modules')
    expect(env.AC_BOTVM_VERSION).toBe('${BOTVM_VERSION}')
  })

  it('configures apt for HTTPS, no SRV lookups and retries before the first apt-get', () => {
    const runs = of('botvm', 'RUN')
    const cfg = runs.findIndex((i) => i.args.includes('/etc/apt/apt.conf.d/80-agentcontrol'))
    expect(cfg).toBeGreaterThanOrEqual(0)
    expect(cfg).toBeLessThan(runs.findIndex((i) => i.args.includes('apt-get')))
    expect(runs[cfg]!.args).toContain('Acquire::EnableSrvRecords "false";')
    expect(runs[cfg]!.args).toContain('Acquire::Retries "5";')
    expect(runs[cfg]!.args).toContain("s|http://deb.debian.org/|https://deb.debian.org/|g")
  })

  it('has no SHELL instruction (Podman OCI builds ignore it)', () => {
    for (const k of SHARED_IMAGE_KINDS) expect(of(k, 'SHELL'), k).toEqual([])
  })

  it('installs tini, coreutils and ca-certificates', () => {
    const run = of('botvm', 'RUN').find((i) => i.args.includes('apt-get install'))!
    for (const p of ['tini', 'coreutils', 'ca-certificates']) expect(run.args).toMatch(new RegExp(`\\b${p}\\b`))
  })
})

describe('botvm-browser layer', () => {
  it('presets PLAYWRIGHT_BROWSERS_PATH, installs only Chromium there, and blocks further downloads', () => {
    const env = pairs('botvm-browser', 'ENV')
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(PLAYWRIGHT_BROWSERS_PATH)
    expect(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1')
    expect(env.NODE_PATH!.split(':')).toEqual(['/home/bot/.local/lib/node_modules', '/usr/local/lib/node_modules'])
    const run = of('botvm-browser', 'RUN').find((i) => i.args.includes('playwright install'))!
    // Full Chromium only: --no-shell skips chromium-headless-shell (its path becomes a link, below).
    expect(run.args).toMatch(/playwright install --with-deps --no-shell chromium(\s|$)/)
    expect(run.args).not.toMatch(/headless[-_]shell|chromium-headless-shell/)
    expect(run.args).toContain('"playwright==${PLAYWRIGHT_VERSION}"')
    expect(run.args).toContain('"playwright@${PLAYWRIGHT_VERSION}"')
    expect(run.args).toContain('chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"')
    // The browser install goes to the system, not into the bot's volumes (nor root's
    // caches into /home/bot); npm first without its bin link so pip owns the CLI.
    expect(run.args).toMatch(/^export HOME=\/root PIP_USER=0 NPM_CONFIG_PREFIX=\/usr\/local /)
    expect(run.args).toContain('npm install -g --no-fund --no-audit --no-bin-links')
    expect(run.args.indexOf('npm install')).toBeLessThan(run.args.indexOf('pip install'))
    // The ENV that sets the browsers path comes before the install.
    const idx = (pred: (i: Instr) => boolean) => instrs['botvm-browser'].findIndex(pred)
    expect(idx((i) => i.op === 'ENV' && i.args.startsWith('PLAYWRIGHT_BROWSERS_PATH='))).toBeLessThan(idx((i) => i === run))
  })

  it('runs Chromium without its own sandbox (the container is the sandbox)', () => {
    expect(pairs('botvm-browser', 'ENV').PLAYWRIGHT_CHROMIUM_ARGS).toBe('--no-sandbox')
  })

  it('launches full Chromium headless through channel chromium (there is no headless shell)', () => {
    expect(CHROMIUM_LAUNCH_OPTIONS).toEqual({ channel: 'chromium', headless: true, args: ['--no-sandbox'] })
    const cf = readFileSync(containerfilePath('botvm-browser'), 'utf8')
    expect(cf).toContain('chromium.launch(channel="chromium", args=["--no-sandbox"])')
  })

  it('links the headless-shell path to full Chromium after the install, so a bare launch() works', () => {
    const runs = of('botvm-browser', 'RUN')
    const install = runs.findIndex((i) => i.args.includes('playwright install'))
    const link = runs.findIndex((i) => i.args.includes('link-headless-shell.sh'))
    expect(link).toBeGreaterThan(install)
    expect(runs[link]!.args).toMatch(/^sh \/usr\/local\/lib\/agentcontrol\/link-headless-shell\.sh\s+&& rm -rf \/usr\/local\/lib\/agentcontrol$/)
    expect(of('botvm-browser', 'COPY').map((i) => i.args)).toEqual(['link-headless-shell.sh /usr/local/lib/agentcontrol/link-headless-shell.sh'])
    // Still root at that point (it writes under the browsers path); back to 1000 at the end.
    const users = instrs['botvm-browser'].filter((i) => i.op === 'USER').map((i) => i.args)
    expect(users).toEqual(['root', '1000:1000'])
  })

  it('link-headless-shell.sh: relative link to full Chromium, revisions from both drivers, fails loudly', () => {
    const script = path.join(vmDir(), 'images', 'botvm-browser', 'link-headless-shell.sh')
    const text = readFileSync(script, 'utf8')
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    expect(text).toMatch(/^set -eu$/m)
    expect(text).toContain('rev "$py_json" chromium-headless-shell')
    expect(text).toContain('playwright-core/browsers.json')
    expect(text).toContain('ln -s "../../chromium-$full_rev/$full_dir/chrome" "$dest/$shell_dir/chrome-headless-shell"')
    expect(text).toContain('x86_64) full_dir=chrome-linux64; shell_dir=chrome-headless-shell-linux64')
    expect(text).toContain('aarch64|arm64) full_dir=chrome-linux-arm64; shell_dir=chrome-headless-shell-linux-arm64')
    expect(text).toContain('touch "$dest/INSTALLATION_COMPLETE" "$dest/DEPENDENCIES_VALIDATED"')
    if (process.platform !== 'win32') execFileSync('sh', ['-n', script])
  })

  it('has one bot-facing launch note: channel chromium recommended, bare launch() works', () => {
    expect(BROWSER_LAUNCH_NOTE).toContain("channel 'chromium'")
    expect(BROWSER_LAUNCH_NOTE).toContain('p.chromium.launch(channel="chromium")')
    expect(BROWSER_LAUNCH_NOTE).toContain("chromium.launch({ channel: 'chromium' })")
    expect(BROWSER_LAUNCH_NOTE).toContain('a plain chromium.launch() also works')
    expect(BROWSER_LAUNCH_NOTE).toContain('Use the preinstalled Playwright; do not install, upgrade or pin another Playwright version')
  })
})

describe('image names', () => {
  it('shared refs are local and versioned; the bot layer FROMs the right base', () => {
    expect(sharedImageRef('botvm')).toBe(`localhost/agentcontrol/botvm:${BOTVM_PINS.BOTVM_VERSION}`)
    expect(sharedImageRef('botvm-browser', '9.9.9')).toBe('localhost/agentcontrol/botvm-browser:9.9.9')
    expect(baseImageFor('base')).toBe(sharedImageRef('botvm'))
    expect(baseImageFor('browser')).toBe(sharedImageRef('botvm-browser'))
    expect(sharedImagesToBuild({ browser: false })).toEqual(['botvm'])
    expect(sharedImagesToBuild({ browser: true })).toEqual(['botvm', 'botvm-browser'])
  })

  it('per-bot names follow the plan and reject anything that is not a slug', () => {
    expect(botImageRef('analyst', 3)).toBe('localhost/ac-bot-analyst:3')
    expect(botContainerName('analyst')).toBe('ac-bot-analyst')
    expect(botToolsVolume('analyst')).toBe('ac-tools-analyst')
    expect(botOptVolume('analyst')).toBe('ac-opt-analyst')
    for (const bad of ['', 'Analyst', '../x', 'a b', 'a;rm', '-x', 'a'.repeat(64)]) {
      expect(() => botContainerName(bad)).toThrow(/invalid bot slug/)
    }
    expect(() => botImageRef('analyst', -1)).toThrow(/generation/)
    expect(() => botImageRef('analyst', 1.5)).toThrow(/generation/)
  })

  it('botLayerContainerfile: base only, or root apt install back to uid 1000; sorted, deduped, validated', () => {
    expect(botLayerContainerfile({ slug: 'analyst', generation: 0, base: 'base', packages: [] })).toBe(
      `FROM ${sharedImageRef('botvm')}\nLABEL io.agentcontrol.image="ac-bot" io.agentcontrol.agent="analyst" io.agentcontrol.generation="0"\n`,
    )
    const cf = botLayerContainerfile({ slug: 'analyst', generation: 2, base: 'browser', packages: ['jq', 'ffmpeg', 'jq', 'libxml2-dev'] })
    const lines = cf.trim().split('\n')
    expect(lines[0]).toBe(`FROM ${sharedImageRef('botvm-browser')}`)
    expect(lines.slice(2)).toEqual(['USER root', 'RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg jq libxml2-dev && rm -rf /var/lib/apt/lists/*', 'USER 1000:1000'])
    for (const bad of ['jq; curl evil', '-o', 'A', '$(x)', 'x y']) {
      expect(() => botLayerContainerfile({ slug: 'analyst', generation: 1, base: 'base', packages: [bad] })).toThrow(/invalid apt package/)
    }
  })
})

describe.skipIf(process.platform === 'win32')('vm/build-images.sh', () => {
  const script = path.join(vmDir(), 'build-images.sh')
  // Dry runs must not see a PODMAN_ARGS the caller exported for the @vm build.
  const cleanEnv = (extra: Record<string, string> = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
    if (!('PODMAN_ARGS' in extra)) delete env.PODMAN_ARGS
    return env
  }
  const sh = (...args: string[]) => execFileSync('bash', [script, ...args], { encoding: 'utf8', env: cleanEnv() })

  it('dry-run builds the same argv as imageBuildArgv, base before browser, with uid-1000 smoke checks', () => {
    const lines = sh('--dry-run').trim().split('\n')
    expect(lines).toHaveLength(6)
    const builds = lines.filter((l) => l.startsWith('podman build '))
    expect(builds).toEqual([...SHARED_IMAGE_KINDS.map((k) => ['podman', ...imageBuildArgv(k)].join(' ')), ['podman', ...egressdNftBuildArgv()].join(' ')])
    const smokes = lines.filter((l) => l.startsWith('podman run ')).slice(0, 2)
    expect(smokes).toHaveLength(2)
    for (const s of smokes) {
      expect(s).toContain('--network none')
      expect(s).toContain('--read-only')
      expect(s).toContain('--cap-drop ALL')
      expect(s).toMatch(/id(\\)? -u/)
    }
    // The browser smoke requires the headless-shell path to be a link to full Chromium, then
    // launches from Python and Node both bare and with channel 'chromium', needing HeadlessChrome.
    // (printf %q renders it as $'...', with the inner single quotes as \'.)
    expect(smokes[1]).toContain('test -L "$h" && test "$(readlink -f "$h")" = "$(readlink -f "$f")"')
    expect(smokes[1]).toContain('chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell')
    expect(smokes[1]!).toContain('chromium-*/chrome-linux*/chrome')
    expect(smokes[1]!).toContain('python3 -c \\\'from playwright.sync_api import sync_playwright')
    expect(smokes[1]!).toContain('(("bare", {}), ("channel", {"channel": "chromium", "headless": True, "args": ["--no-sandbox"]}))')
    expect(smokes[1]!).toContain('node -e \\\'const { chromium } = require("playwright");')
    expect(smokes[1]!).toContain('[["bare", {}], ["channel", { channel: "chromium", headless: true, args: ["--no-sandbox"] }]]')
    expect(smokes[1]!.match(/HeadlessChrome\//g)).toHaveLength(2)
  })

  it('BE-P2-13: --only egressd-nft builds the firewall helper FROM botvm, then checks nft runs with no capabilities', () => {
    const lines = sh('--dry-run', '--only', 'egressd-nft').trim().split('\n')
    expect(lines).toEqual([
      ['podman', ...egressdNftBuildArgv()].join(' '),
      `podman run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint nft ${egressdNftImageRef()} --version`,
    ])
    expect(egressdNftBuildArgv()).toEqual(expect.arrayContaining(['--tag', 'localhost/agentcontrol/egressd-nft:1.0.0', `BOTVM_IMAGE=${sharedImageRef('botvm')}`]))
    const cf = readFileSync(path.join(vmDir(), 'images', 'egressd-nft', 'Containerfile'), 'utf8')
    expect(cf).toMatch(/^FROM \$\{BOTVM_IMAGE\}$/m)
    expect(cf).toMatch(/apt-get install -y --no-install-recommends nftables/)
    expect(cf.trim().split('\n').at(-1)).toBe('USER 1000:1000')
  })

  it('supports docker, a podman connection and --only, and never uses podman-machine-default', () => {
    expect(sh('--dry-run', '--engine', 'docker', '--only', 'botvm').trim().split('\n')[0]).toBe(['docker', ...imageBuildArgv('botvm')].join(' '))
    expect(sh('--dry-run', '--connection', 'agentcontrol', '--only', 'botvm-browser').trim().split('\n')[0]).toBe(
      ['podman', '--connection', 'agentcontrol', ...imageBuildArgv('botvm-browser')].join(' '),
    )
    expect(() => execFileSync('bash', [script, '--dry-run', '--connection', 'podman-machine-default'], { stdio: 'pipe', env: cleanEnv() })).toThrow()
    expect(() => execFileSync('bash', [script, '--dry-run', '--engine', 'nerdctl'], { stdio: 'pipe', env: cleanEnv() })).toThrow()
  })

  it('passes extra global podman options from PODMAN_ARGS and --podman-arg before the subcommand (podman only)', () => {
    const out = execFileSync('bash', [script, '--dry-run', '--only', 'botvm', '--podman-arg', '--log-level=warn', '--podman-arg=--cgroup-manager=cgroupfs'], {
      encoding: 'utf8',
      env: cleanEnv({ PODMAN_ARGS: ' --root /tmp/pt/root  --runroot /tmp/pt/runroot ' }),
    })
    const lines = out.trim().split('\n')
    expect(lines).toHaveLength(2)
    const pre = 'podman --root /tmp/pt/root --runroot /tmp/pt/runroot --log-level=warn --cgroup-manager=cgroupfs '
    expect(lines[0]).toBe(pre + imageBuildArgv('botvm').join(' '))
    expect(lines[1]!.startsWith(pre + 'run --rm --network none ')).toBe(true)
    expect(sh('--dry-run', '--only', 'botvm', '--connection', 'agentcontrol', '--podman-arg', '--log-level=warn').split('\n')[0]).toBe(
      ['podman', '--log-level=warn', '--connection', 'agentcontrol', ...imageBuildArgv('botvm')].join(' '),
    )
    expect(() => execFileSync('bash', [script, '--dry-run', '--engine', 'docker', '--podman-arg', '--root=/x'], { stdio: 'pipe', env: cleanEnv() })).toThrow()
    expect(() => execFileSync('bash', [script, '--dry-run', '--engine', 'docker'], { stdio: 'pipe', env: cleanEnv({ PODMAN_ARGS: '--root /x' }) })).toThrow()
    expect(() => execFileSync('bash', [script, '--dry-run', '--podman-arg'], { stdio: 'pipe', env: cleanEnv() })).toThrow()
  })
})

/** @vm: needs a real engine (AC_VM_TESTS=1). Honours PODMAN_ARGS (e.g. a throwaway --root/--runroot). */
const engine = ['podman', 'docker'].find((e) => {
  try {
    execFileSync(e, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})
const vmPodmanArgs = () => (engine === 'podman' ? (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean) : [])
const imageExists = (ref: string) => {
  try {
    execFileSync(engine!, [...vmPodmanArgs(), 'image', 'exists', ref], { stdio: 'ignore', timeout: 60_000 })
    return true
  } catch {
    return false
  }
}
/** Whether the egressd-nft tag was there before the build test ran (undefined: the test didn't run). */
let nftExistedBefore: boolean | undefined
describe.skipIf(process.env.AC_VM_TESTS !== '1' || !engine)('@vm image build', () => {
  it('builds the images (botvm, botvm-browser, egressd-nft); python3, node and chromium run as uid 1000', () => {
    nftExistedBefore = imageExists(egressdNftImageRef())
    const out = execFileSync('bash', [path.join(vmDir(), 'build-images.sh'), '--engine', engine!], { encoding: 'utf8', timeout: 30 * 60_000 })
    expect(out).toMatch(/Python 3\.12\./)
    expect(out).toMatch(/v22\./)
    // BE-P2-13: the firewall helper runs nft.
    expect(out).toMatch(/^nftables v1\./m)
    // No headless shell in the image: its path is a link to the full Chromium binary.
    expect(out).toMatch(new RegExp(`^headless shell: link to ${PLAYWRIGHT_BROWSERS_PATH}/chromium-\\d+/chrome-linux(64|-arm64)/chrome$`, 'm'))
    // Both drivers launched Chromium headless as uid 1000, bare and with channel 'chromium'.
    for (const lang of ['python', 'node']) for (const how of ['bare', 'channel']) {
      expect(out).toMatch(new RegExp(`^${lang} ${how} \\d+\\.\\d+\\.\\d+\\.\\d+ HeadlessChrome$`, 'm'))
    }
  }, 30 * 60_000)

  // Remove the firewall helper tag only if this run built it. One that was
  // already there (e.g. from build-images.sh) stays, so egress.vm keeps it.
  afterAll(() => {
    if (nftExistedBefore !== false) return
    try {
      execFileSync(engine!, [...vmPodmanArgs(), 'rmi', egressdNftImageRef()], { stdio: 'pipe', timeout: 120_000 })
    } catch {
      // Already gone: nothing to clean up.
    }
  })

  // What a bot-written script does: plain chromium.launch(), no channel, no args, default headless.
  it('a bare chromium.launch() works from Python and Node as uid 1000 with no network', () => {
    const podmanArgs = engine === 'podman' ? (process.env.PODMAN_ARGS ?? '').split(/\s+/).filter(Boolean) : []
    const run = (cmd: string[]) =>
      execFileSync(engine!, [
        ...podmanArgs, 'run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--tmpfs', '/tmp:rw,size=512m',
        '--shm-size', '512m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', sharedImageRef('botvm-browser'), ...cmd,
      ], { encoding: 'utf8', timeout: 5 * 60_000 })
    const py = run(['python3', '-c', [
      'from playwright.sync_api import sync_playwright',
      'with sync_playwright() as p:',
      '    b = p.chromium.launch()',
      '    pg = b.new_page()',
      '    pg.goto("data:text/html,<title>bare</title>")',
      '    import os; print(os.getuid(), pg.title(), pg.evaluate("navigator.userAgent"))',
      '    b.close()',
    ].join('\n')])
    expect(py).toMatch(/^1000 bare .*HeadlessChrome\/\d+/m)
    const js = run(['node', '-e', [
      'const { chromium } = require("playwright");',
      '(async () => { const b = await chromium.launch(); const pg = await b.newPage(); await pg.goto("about:blank");',
      '  console.log(process.getuid(), pg.url(), await pg.evaluate(() => navigator.userAgent)); await b.close() })()',
      '  .catch((e) => { console.error(e); process.exit(1) })',
    ].join('\n')])
    expect(js).toMatch(/^1000 about:blank .*HeadlessChrome\/\d+/m)
  }, 10 * 60_000)
})

it('the vm/ folder ships next to src/ (and dist/)', () => {
  expect(existsSync(containerfilePath('botvm'))).toBe(true)
  expect(existsSync(containerfilePath('botvm-browser'))).toBe(true)
})
