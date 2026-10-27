/**
 * BE-P2-3: the shared bot images (plan §2.2) and the per-bot image layer names.
 *
 * - `localhost/agentcontrol/botvm:<ver>`: Debian slim, Python 3.12, Node 22, uid 1000.
 * - `localhost/agentcontrol/botvm-browser:<ver>`: botvm + Playwright + full Chromium (no headless shell;
 *   launch with `CHROMIUM_LAUNCH_OPTIONS`, i.e. channel 'chromium' in new headless mode; a bare
 *   `chromium.launch()` reaches the same binary through the headless-shell link).
 * - `localhost/ac-bot-<slug>:<gen>`: the bot's own layer (FROM one of the above + vm.packages),
 *   built by BotEnvService (BE-P2-4) from `botLayerContainerfile()`.
 *
 * There is no registry: images are built locally (`vm/build-images.sh`, or `imageBuildArgv()`
 * through the engine command runner). Versions are pinned in `vm/images/versions.env`;
 * BOTVM_PINS mirrors them and a test keeps the two in step.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Pinned versions (mirror of vm/images/versions.env). */
export const BOTVM_PINS = {
  BOTVM_VERSION: '1.0.0',
  BASE_IMAGE: 'docker.io/library/python:3.12.16-slim-bookworm@sha256:6dd8b6dab6b3adc7812bab69eca5dbdc1a5cc690ad28306d234ffb4ef8ac9753',
  PYTHON_VERSION: '3.12.16',
  NODE_VERSION: '22.23.4',
  NODE_SHA256_X64: '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce',
  NODE_SHA256_ARM64: '6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b',
  PLAYWRIGHT_VERSION: '1.64.1',
} as const

export const BOTVM_VERSION = BOTVM_PINS.BOTVM_VERSION
export const BOTVM_REPO = 'localhost/agentcontrol'
export type SharedImageKind = 'botvm' | 'botvm-browser'
export const SHARED_IMAGE_KINDS: readonly SharedImageKind[] = ['botvm', 'botvm-browser']

/** Inside every bot container (plan §2.2). */
export const BOT_UID = 1000
export const BOT_GID = 1000
export const BOT_PATHS = {
  root: '/bot',
  workspace: '/bot/workspace',
  inputs: '/bot/shared',
  skills: '/bot/skills',
  groups: '/bot/groups',
  home: '/home/bot',
  opt: '/opt/bot',
  optBin: '/opt/bot/bin',
  tmp: '/tmp',
} as const
/** Where the browser image keeps Chromium (read-only at run time). */
export const PLAYWRIGHT_BROWSERS_PATH = '/opt/ms-playwright'
/**
 * How AgentControl's own code in botvm-browser launches Chromium (the recommended launch). The
 * image has only full Chromium (installed with `--no-shell`); `channel: 'chromium'` runs it in
 * the new headless mode. `--no-sandbox`: the container is the sandbox (Playwright adds it by
 * default too). A bare `chromium.launch()` also works: the headless-shell path Playwright uses
 * by default is a link to the same full Chromium (vm/images/botvm-browser/link-headless-shell.sh).
 */
export const CHROMIUM_LAUNCH_OPTIONS = { channel: 'chromium', headless: true, args: ['--no-sandbox'] } as const

/**
 * Bot-facing note on launching the browser, for the model-facing text that will mention it:
 * the `run_script` tool's `browser` parameter description (BE-P2-16) and the bundled
 * `browser-basics` skill (BE-P2-15, plan §9). Neither exists yet; they should use this text.
 */
export const BROWSER_LAUNCH_NOTE =
  "Chromium is preinstalled for Playwright (Python and Node). Launch it with channel 'chromium' " +
  "(Python: p.chromium.launch(channel=\"chromium\"); Node: chromium.launch({ channel: 'chromium' })); " +
  'a plain chromium.launch() also works. It runs headless; do not install browsers. ' +
  'Use the preinstalled Playwright; do not install, upgrade or pin another Playwright version, or the browser will not launch.'

/** Image label keys AgentControl sets and reads back (e.g. to detect a stale base). */
export const IMAGE_LABELS = { image: 'io.agentcontrol.image', version: 'io.agentcontrol.version', agent: 'io.agentcontrol.agent', generation: 'io.agentcontrol.generation' } as const

/**
 * Approximate sizes for the VM tab and Settings › VMs until the engine reports real ones.
 * Measured on the real Podman build of 1.0.0 (linux/amd64, 2026-10-27): 430.7 MB and 1343.4 MB (1343.3 before the headless-shell link, +15 kB)
 * (the browser size includes botvm; full Chromium only, installed with `--no-shell`).
 */
export const SHARED_IMAGE_APPROX_BYTES: Record<SharedImageKind, number> = { botvm: 431 * 1000 ** 2, 'botvm-browser': 1343 * 1000 ** 2 }

export function sharedImageRef(kind: SharedImageKind, version: string = BOTVM_VERSION): string {
  return `${BOTVM_REPO}/${kind}:${version}`
}

/** AgentVm.image.base → the shared image a bot layer builds FROM. */
export function baseImageFor(base: 'base' | 'browser', version: string = BOTVM_VERSION): string {
  return sharedImageRef(base === 'browser' ? 'botvm-browser' : 'botvm', version)
}

/** Slugs are already [a-z0-9-]; this guards anything that reaches an engine argv. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
function checkSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new Error(`invalid bot slug for an image or container name: ${JSON.stringify(slug.slice(0, 80))}`)
  return slug
}

export const botImageName = (slug: string) => `localhost/ac-bot-${checkSlug(slug)}`
export function botImageRef(slug: string, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) throw new Error(`invalid image generation: ${generation}`)
  return `${botImageName(slug)}:${generation}`
}
export const botContainerName = (slug: string) => `ac-bot-${checkSlug(slug)}`
export const botToolsVolume = (slug: string) => `ac-tools-${checkSlug(slug)}`
export const botOptVolume = (slug: string) => `ac-opt-${checkSlug(slug)}`

/** Debian package names (same rule the vm.packages normalizer uses). */
export const APT_PACKAGE = /^[a-z0-9][a-z0-9+.-]{0,127}$/

/**
 * The per-bot layer's Containerfile: FROM the shared base + the bot's apt packages,
 * back to uid 1000 at the end. Packages are validated and sorted so the same list gives
 * the same file. Nothing secret or bot-controlled besides package names goes in.
 */
export function botLayerContainerfile(opts: { slug: string; generation: number; base: 'base' | 'browser'; packages: readonly string[]; version?: string }): string {
  checkSlug(opts.slug)
  const bad = opts.packages.filter((p) => !APT_PACKAGE.test(p))
  if (bad.length) throw new Error(`invalid apt package name: ${JSON.stringify(bad[0]!.slice(0, 80))}`)
  const pkgs = [...new Set(opts.packages)].sort()
  const lines = [
    `FROM ${baseImageFor(opts.base, opts.version)}`,
    `LABEL ${IMAGE_LABELS.image}="ac-bot" ${IMAGE_LABELS.agent}="${opts.slug}" ${IMAGE_LABELS.generation}="${opts.generation}"`,
  ]
  if (pkgs.length) {
    lines.push(
      'USER root',
      `RUN apt-get update && apt-get install -y --no-install-recommends ${pkgs.join(' ')} && rm -rf /var/lib/apt/lists/*`,
      `USER ${BOT_UID}:${BOT_GID}`,
    )
  }
  return lines.join('\n') + '\n'
}

/** vm/ next to src/ and dist/ (both one level under the package root). */
export function vmDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vm')
}
export function containerfilePath(kind: SharedImageKind): string {
  return path.join(vmDir(), 'images', kind, 'Containerfile')
}

/**
 * Engine argv (without the `podman`/`docker` and any `--connection`) to build a shared
 * image, the same as vm/build-images.sh does. For the command runner in BE-P2-2/4.
 */
export function imageBuildArgv(kind: SharedImageKind): string[] {
  const p = BOTVM_PINS
  const buildArgs: Record<string, string> =
    kind === 'botvm'
      ? { BASE_IMAGE: p.BASE_IMAGE, BOTVM_VERSION: p.BOTVM_VERSION, PYTHON_VERSION: p.PYTHON_VERSION, NODE_VERSION: p.NODE_VERSION, NODE_SHA256_X64: p.NODE_SHA256_X64, NODE_SHA256_ARM64: p.NODE_SHA256_ARM64 }
      : { BOTVM_IMAGE: sharedImageRef('botvm'), BOTVM_VERSION: p.BOTVM_VERSION, PLAYWRIGHT_VERSION: p.PLAYWRIGHT_VERSION }
  return [
    'build',
    '--file', containerfilePath(kind),
    '--tag', sharedImageRef(kind),
    ...Object.entries(buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]),
    path.dirname(containerfilePath(kind)),
  ]
}

/** Shared images in build order (browser needs botvm first). */
export function sharedImagesToBuild(opts: { browser: boolean }): SharedImageKind[] {
  return opts.browser ? ['botvm', 'botvm-browser'] : ['botvm']
}
