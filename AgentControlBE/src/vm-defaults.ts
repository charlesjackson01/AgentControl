/**
 * BE-P2-1: Phase 2 defaults and load-time normalizers for per-bot VM state
 * (Agent.vm) and the global VM settings (settings.vm). Both are idempotent:
 * old data loads, malformed fields fall back to defaults, valid ones are kept.
 */
import {
  ENV_NAME,
  GLOBAL_RUNTIME_MODES,
  MAX_ENV_VALUE_CHARS,
  MAX_ENV_VARS,
  RESERVED_ENV_NAMES,
  RESERVED_ENV_PREFIX,
  RUNTIME_MODES,
  BACKUP_KEEP_BOUNDS,
  SNAPSHOT_BUDGET_BOUNDS,
  type AgentVm,
  type EnvVar,
  type GlobalRuntimeMode,
  type RuntimeMode,
  type ToolManifest,
  type VmSettings,
  type VmSettingsView,
} from './shared/types.js'

export function defaultAgentVm(): AgentVm {
  return { permissions: { browser: false }, gvisor: 'inherit', env: [], packages: [], image: { generation: 0, base: 'base' }, egress: { allow: [] } }
}

export const DEFAULT_VM_SETTINGS: Readonly<VmSettingsView> = Object.freeze({
  gvisor: 'auto',
  backups: { enabled: process.platform === 'win32', time: '03:00', keep: 7 },
  snapshotBudget: { perBotMb: 2048, globalMb: 15360, freeFloorMb: 5120 },
})

export function defaultVmSettings(): VmSettings {
  return structuredClone(DEFAULT_VM_SETTINGS) as VmSettings
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** Plain-language problem with an env var name, or null when it's allowed. */
export function envNameProblem(name: string): string | null {
  if (!ENV_NAME.test(name)) return `"${name.slice(0, 64)}" isn't a valid variable name. Use letters, digits and _, starting with a letter or _.`
  const upper = name.toUpperCase()
  if (upper === 'PATH') return '"PATH" is reserved. Use PATH_APPEND to add folders to it.'
  if (RESERVED_ENV_NAMES.includes(upper)) return `"${name}" is reserved and set by AgentControl.`
  if (upper.startsWith(RESERVED_ENV_PREFIX)) return `Names starting with ${RESERVED_ENV_PREFIX} are reserved for AgentControl.`
  return null
}

/** Stored env vars: valid, unreserved, unique by name (first wins), capped. */
function normalizeEnv(raw: unknown): EnvVar[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: EnvVar[] = []
  for (const e of raw) {
    if (!isObj(e) || typeof e.name !== 'string' || typeof e.value !== 'string') continue
    if (envNameProblem(e.name) !== null || e.value.length > MAX_ENV_VALUE_CHARS || seen.has(e.name)) continue
    seen.add(e.name)
    out.push({ name: e.name, value: e.value })
    if (out.length === MAX_ENV_VARS) break
  }
  return out
}

function normalizeTools(raw: unknown): ToolManifest | undefined {
  if (!isObj(raw) || typeof raw.updatedAt !== 'string') return undefined
  return { pip: strList(raw.pip), npm: strList(raw.npm), optBin: strList(raw.optBin), updatedAt: raw.updatedAt }
}

/** Agent.vm from stored data; returns the normalized value and whether it differs from the input. */
export function normalizeAgentVm(raw: unknown): { vm: AgentVm; changed: boolean } {
  const vm = defaultAgentVm()
  if (isObj(raw)) {
    if (isObj(raw.permissions) && typeof raw.permissions.browser === 'boolean') vm.permissions.browser = raw.permissions.browser
    if (RUNTIME_MODES.includes(raw.gvisor as RuntimeMode)) vm.gvisor = raw.gvisor as RuntimeMode
    vm.env = normalizeEnv(raw.env)
    vm.packages = [...new Set(strList(raw.packages).filter((p) => /^[a-z0-9][a-z0-9+.-]{0,127}$/.test(p)))]
    if (isObj(raw.image)) {
      const img = raw.image
      if (nonNegInt(img.generation)) vm.image.generation = img.generation
      if (nonNegInt(img.previous) && img.previous < vm.image.generation) vm.image.previous = img.previous
      if (typeof img.builtAt === 'string') vm.image.builtAt = img.builtAt
      if (img.base === 'browser') vm.image.base = 'browser'
    }
    const tools = normalizeTools(raw.tools)
    if (tools) vm.tools = tools
  }
  return { vm, changed: JSON.stringify(vm) !== JSON.stringify(raw) }
}

const within = (v: unknown, b: { min: number; max: number }): v is number => typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max

/** settings.vm from stored data. */
export function normalizeVmSettings(raw: unknown): { vm: VmSettings; changed: boolean } {
  const vm = defaultVmSettings()
  if (isObj(raw)) {
    if (GLOBAL_RUNTIME_MODES.includes(raw.gvisor as GlobalRuntimeMode)) vm.gvisor = raw.gvisor as GlobalRuntimeMode
    if (isObj(raw.backups)) {
      const b = raw.backups
      if (typeof b.enabled === 'boolean') vm.backups.enabled = b.enabled
      if (typeof b.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) vm.backups.time = b.time
      if (within(b.keep, BACKUP_KEEP_BOUNDS)) vm.backups.keep = b.keep
    }
    if (isObj(raw.snapshotBudget)) {
      const s = raw.snapshotBudget
      for (const key of ['perBotMb', 'globalMb', 'freeFloorMb'] as const) {
        if (within(s[key], SNAPSHOT_BUDGET_BOUNDS[key])) vm.snapshotBudget[key] = s[key] as number
      }
    }
    if (typeof raw.volumeId === 'string' && raw.volumeId) vm.volumeId = raw.volumeId
    if (isObj(raw.machine) && typeof raw.machine.diskGb === 'number' && raw.machine.diskGb >= 60) vm.machine = { diskGb: raw.machine.diskGb }
  }
  return { vm, changed: JSON.stringify(vm) !== JSON.stringify(raw) }
}

/** What GET /api/vm/settings serves: no server-only fields. */
export function vmSettingsView(vm: VmSettings): VmSettingsView {
  const { volumeId: _v, machine: _m, ...view } = vm
  return structuredClone(view)
}
