/**
 * BE-P2-17: global VM settings (contract "Global").
 *
 *   GET   /api/vm/settings → VmSettingsView
 *   PATCH /api/vm/settings  VmSettingsPatch → VmSettingsView
 *
 * PATCH is partial (only the keys sent change) and all-or-nothing: any bad key or value → 400 and
 * nothing is saved. Bounds: SNAPSHOT_BUDGET_BOUNDS (MB) and BACKUP_KEEP_BOUNDS; the per-bot undo
 * budget can't be above the total. After a save, a changed gvisor re-probes
 * (app.vmRuntimeModeChanged) and a changed snapshot budget is enforced right away
 * (app.vmSnapshotBudget.enforce). Server-only fields (volumeId, machine) are never served or
 * changed here.
 */
import type { FastifyInstance } from 'fastify'
import { fail } from './http.js'
import type { WorkspaceStore } from './store.js'
import {
  BACKUP_KEEP_BOUNDS,
  GLOBAL_RUNTIME_MODES,
  SNAPSHOT_BUDGET_BOUNDS,
  type GlobalRuntimeMode,
  type VmSettings,
  type VmSettingsView,
} from './shared/types.js'
import { defaultVmSettings, vmSettingsView } from './vm-defaults.js'

export interface VmSettingsRouteDeps {
  /** After a saved change of the global gVisor mode (app.vmRuntimeModeChanged). */
  runtimeModeChanged?: () => void
  /** After a saved change of the snapshot budget (app.vmSnapshotBudget.enforce). */
  budgetChanged?: () => void
}

export const PER_BOT_OVER_GLOBAL = "The undo budget per bot can't be larger than the total undo budget."

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const TOP_KEYS = ['gvisor', 'backups', 'snapshotBudget'] as const
const BACKUP_KEYS = ['enabled', 'time', 'keep'] as const
const BUDGET_KEYS = ['perBotMb', 'globalMb', 'freeFloorMb'] as const
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const unknownKey = (raw: Record<string, unknown>, allowed: readonly string[], prefix = ''): void => {
  const extra = Object.keys(raw).find((k) => !allowed.includes(k))
  if (extra !== undefined) fail(400, `"${prefix}${extra.slice(0, 40)}" can't be changed here.`)
}
const wholeIn = (v: unknown, b: { min: number; max: number }): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max

/** The settings after applying a PATCH body; 400 via fail() on any problem. Pure. */
export function applyVmSettingsPatch(current: VmSettings, body: unknown): VmSettings {
  if (!isObj(body)) fail(400, 'Send a JSON object, e.g. {"gvisor": "auto"}.')
  unknownKey(body, TOP_KEYS)
  const next: VmSettings = structuredClone(current)
  if (body.gvisor !== undefined) {
    if (!GLOBAL_RUNTIME_MODES.includes(body.gvisor as GlobalRuntimeMode)) fail(400, '"gvisor" must be "auto", "force_on" or "force_off".')
    next.gvisor = body.gvisor as GlobalRuntimeMode
  }
  if (body.backups !== undefined) {
    const b = body.backups
    if (!isObj(b)) fail(400, '"backups" must be an object, e.g. {"keep": 7}.')
    unknownKey(b, BACKUP_KEYS, 'backups.')
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== 'boolean') fail(400, '"backups.enabled" must be true or false.')
      next.backups.enabled = b.enabled
    }
    if (b.time !== undefined) {
      if (typeof b.time !== 'string' || !TIME.test(b.time)) fail(400, '"backups.time" must be a 24-hour time like "03:00".')
      next.backups.time = b.time
    }
    if (b.keep !== undefined) {
      if (!wholeIn(b.keep, BACKUP_KEEP_BOUNDS)) fail(400, `"backups.keep" must be a whole number from ${BACKUP_KEEP_BOUNDS.min} to ${BACKUP_KEEP_BOUNDS.max}.`)
      next.backups.keep = b.keep
    }
  }
  if (body.snapshotBudget !== undefined) {
    const s = body.snapshotBudget
    if (!isObj(s)) fail(400, '"snapshotBudget" must be an object, e.g. {"perBotMb": 2048}.')
    unknownKey(s, BUDGET_KEYS, 'snapshotBudget.')
    for (const key of BUDGET_KEYS) {
      if (s[key] === undefined) continue
      const b = SNAPSHOT_BUDGET_BOUNDS[key]
      if (!wholeIn(s[key], b)) fail(400, `"snapshotBudget.${key}" must be a whole number of MB from ${b.min} to ${b.max}.`)
      next.snapshotBudget[key] = s[key] as number
    }
    if (next.snapshotBudget.perBotMb > next.snapshotBudget.globalMb) fail(400, PER_BOT_OVER_GLOBAL)
  }
  return next
}

export function registerVmSettingsRoutes(app: FastifyInstance, store: WorkspaceStore, deps: VmSettingsRouteDeps = {}): void {
  const current = (): VmSettings => store.settings.vm ?? defaultVmSettings()

  app.get('/api/vm/settings', async (): Promise<VmSettingsView> => vmSettingsView(current()))

  app.patch('/api/vm/settings', async (request): Promise<VmSettingsView> => {
    const before = current()
    const next = applyVmSettingsPatch(before, request.body)
    const previous = store.settings
    store.settings = { ...store.settings, vm: next }
    if (!store.save()) {
      store.settings = previous
      fail(500, "Couldn't save the change. Try again.")
    }
    if (next.gvisor !== before.gvisor) deps.runtimeModeChanged?.()
    if (BUDGET_KEYS.some((k) => next.snapshotBudget[k] !== before.snapshotBudget[k])) deps.budgetChanged?.()
    return vmSettingsView(next)
  })
}
