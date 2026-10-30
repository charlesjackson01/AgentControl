/**
 * BE-P2-10: the bot's personal data (plan §5) — its folder (workspace, shared inputs, memory,
 * BOT.md), the ac-tools / ac-opt volumes and its own image layer — against the 10 GB limit.
 * The folder is measured on every check (a walk of bots/<slug>); the volumes and the layer come
 * from the engine (BotEnvService.measure) and are cached for 10 minutes, refreshed before a run
 * once stale and by the 10-minute sweep. Over the limit, new runs are blocked with
 * `personalBlockMessage`; user writes to the bot's folder were already capped (files.ts quota),
 * and now count the volumes and layer too (`setPersonalExtraBytes`).
 */
import type { Agent } from './shared/types.js'
import { gbText } from './snapshot-budget.js'

export const PERSONAL_MEASURE_MS = 10 * 60 * 1000
export const PERSONAL_QUOTA_REASON = 'personal_quota'

export interface PersonalBreakdown {
  workspace: number
  inputs: number
  memory: number
  tools: number
  opt: number
  imageLayer: number
}

export type EngineParts = Partial<Pick<PersonalBreakdown, 'tools' | 'opt' | 'imageLayer'>>

export interface PersonalUsageDeps {
  /** The bot's folder parts (memory includes BOT.md). */
  folder: (agent: Agent) => Pick<PersonalBreakdown, 'workspace' | 'inputs' | 'memory'>
  /** Volumes and layer from the engine; parts it couldn't measure are left out (the last value stays). */
  engine?: (agent: Agent) => Promise<EngineParts>
  quotaBytes: () => number
  ttlMs?: number
  now?: () => Date
}

export interface PersonalCheck {
  breakdown: PersonalBreakdown
  usedBytes: number
  quotaBytes: number
  /** The run block message when over the limit, else null. */
  blocked: string | null
}

export interface PersonalUsage {
  /** The folder now plus the last engine values (no engine call). */
  breakdown(agent: Agent): PersonalBreakdown
  /** Engine parts (tools, opt, layer) from the cache. */
  engineBytes(agent: Agent): number
  /** Re-measure the engine parts (always with `force`, else once older than 10 min). */
  refresh(agent: Agent, opts?: { force?: boolean }): Promise<void>
  /** Before a run: refresh when stale, then compare with the limit. */
  check(agent: Agent): Promise<PersonalCheck>
  forget(agent: Agent): void
}

export const sumBreakdown = (b: PersonalBreakdown): number => b.workspace + b.inputs + b.memory + b.tools + b.opt + b.imageLayer

/** "Analyst's files and tools use 10.2 of 10 GB. Free space in Files or remove tools in Settings › VM." */
export function personalBlockMessage(botName: string, usedBytes: number, quotaBytes: number): string {
  return `${botName}'s files and tools use ${gbText(usedBytes)} of ${gbText(quotaBytes)} GB. Free space in Files or remove tools in Settings › VM.`
}

export function createPersonalUsage(deps: PersonalUsageDeps): PersonalUsage {
  const now = deps.now ?? (() => new Date())
  const ttl = deps.ttlMs ?? PERSONAL_MEASURE_MS
  const cache = new Map<string, { at: number; parts: Required<EngineParts> }>()
  const inflight = new Map<string, Promise<void>>()

  const partsOf = (agent: Agent): Required<EngineParts> => cache.get(agent.id)?.parts ?? { tools: 0, opt: 0, imageLayer: 0 }
  const breakdown = (agent: Agent): PersonalBreakdown => ({ ...deps.folder(agent), ...partsOf(agent) })

  async function refresh(agent: Agent, opts: { force?: boolean } = {}): Promise<void> {
    if (!deps.engine) return
    const hit = cache.get(agent.id)
    if (!opts.force && hit && now().getTime() - hit.at < ttl) return
    const running = inflight.get(agent.id)
    if (running) return running
    const p = (async () => {
      const got = await deps.engine!(agent).catch(() => ({}) as EngineParts)
      cache.set(agent.id, { at: now().getTime(), parts: { ...partsOf(agent), ...got } })
    })().finally(() => inflight.delete(agent.id))
    inflight.set(agent.id, p)
    return p
  }

  return {
    breakdown,
    engineBytes: (agent) => {
      const p = partsOf(agent)
      return p.tools + p.opt + p.imageLayer
    },
    refresh,
    async check(agent) {
      await refresh(agent)
      const b = breakdown(agent)
      const used = sumBreakdown(b)
      const quota = deps.quotaBytes()
      return { breakdown: b, usedBytes: used, quotaBytes: quota, blocked: used > quota ? personalBlockMessage(agent.name, used, quota) : null }
    },
    forget: (agent) => {
      cache.delete(agent.id)
    },
  }
}
