/*
 * FE-3 Skills tab: the library grouped by source (03c), toggle diffing and the
 * catalog token meter. Accepts today's `GET /api/skills` (Skill[]) and BE-6's
 * `{ skills, sources }`. Pure; tests/skills-catalog.test.mjs.
 */
import type { PromptBudget, SkillSource, SkillSummary } from './types.ts'

export type SkillsResponse = { skills: SkillSummary[]; sources: SkillSource[]; legacy: boolean }

/** Today's plain `Skill[]` (legacy, bodies included) or BE-6's `{ skills, sources }` (no bodies). */
export function normalizeSkillsResponse(body: unknown): SkillsResponse {
  if (Array.isArray(body)) return { skills: body as SkillSummary[], sources: [], legacy: true }
  const b = (body ?? {}) as { skills?: unknown; sources?: unknown }
  return {
    skills: Array.isArray(b.skills) ? (b.skills as SkillSummary[]) : [],
    sources: Array.isArray(b.sources) ? (b.sources as SkillSource[]) : [],
    legacy: false,
  }
}

/** 03c titles; anything else shows its repo or id. */
const SOURCE_TITLES: Record<string, string> = {
  superpowers: 'obra/superpowers',
  anthropics: 'anthropics/skills',
  ecc: 'affaan-m/ECC',
  core: 'AgentControl core',
  custom: 'Imported',
}
/** 03c: what a vendored copy leaves out. */
const GROUP_NOTES: Record<string, string> = {
  anthropics: 'docx, pdf, pptx, xlsx not included (proprietary licence)',
}

/** 03c order: vendored repos, then core, then the user's own imports. */
const SOURCE_ORDER = ['superpowers', 'anthropics', 'ecc', 'core', 'custom']

/** BE-6 vendored sources: pinned upstream copies, never edited here. */
export const VENDORED_SOURCES: readonly string[] = ['superpowers', 'anthropics', 'ecc']

export function isVendored(s: Pick<SkillSummary, 'sourceId' | 'source'>): boolean {
  return VENDORED_SOURCES.includes(skillSourceId(s))
}

/** `/api/skills/:id` — BE-6 ids contain `/` (`core/summarization`), so the id is one encoded segment. */
export function skillPath(id: string): string {
  return `/api/skills/${encodeURIComponent(id)}`
}

/** Detail line for a skill: where it's from and what's inside. */
export function skillDetailLine(s: SkillSummary): string {
  const parts: string[] = []
  if (isVendored(s)) parts.push(`Read-only · vendored${s.sourceRepo ? ` from ${s.sourceRepo}` : ''}${s.sourceCommit ? ` @ ${shortCommit(s.sourceCommit)}` : ''}`)
  else if (skillSourceId(s) === 'core') parts.push('Built in')
  else parts.push('Imported')
  if (s.license) parts.push(s.license)
  if (s.files?.length) parts.push(`${s.files.length} file${s.files.length === 1 ? '' : 's'}`)
  if (s.defaultOn) parts.push('on by default for new bots')
  return parts.join(' · ')
}

export type SkillGroup = {
  id: string
  title: string
  /** Vendored source: its skills are read-only. */
  readOnly: boolean
  /** "MIT · pinned @ bb92a77" / "Built in"; '' when unknown. */
  meta: string
  skills: SkillSummary[]
  enabled: number
  total: number
  /** Fixed note after the group's rows (03c). */
  note?: string
}

/**
 * Pre-BE-6 skills have no sourceId: group them by their provenance string
 * ("seb1n/awesome-ai-agent-skills"); the built-in seeds say "AgentControl".
 */
export function skillSourceId(s: Pick<SkillSummary, 'sourceId' | 'source'>): string {
  if (s.sourceId) return s.sourceId
  if (!s.source || s.source === 'AgentControl') return 'core'
  return s.source
}

export function shortCommit(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : ''
}

export function groupSkills(
  skills: readonly SkillSummary[],
  sources: readonly SkillSource[],
  enabledIds: readonly string[],
  query = '',
  /**
   * Which skills sort first ("on first, then by name"). Pass the ids the tab
   * opened with so a row doesn't jump under the cursor when it's toggled.
   */
  orderIds: readonly string[] = enabledIds,
): SkillGroup[] {
  const q = query.trim().toLowerCase()
  const on = new Set(enabledIds)
  const upFront = new Set(orderIds)
  const byId = new Map<string, SkillSummary[]>()
  for (const s of skills) {
    const id = skillSourceId(s)
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id)!.push(s)
  }
  const rank = (id: string) => {
    const i = SOURCE_ORDER.indexOf(id)
    return i === -1 ? SOURCE_ORDER.length : i
  }
  return [...byId.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([id, list]) => {
      const src = sources.find((x) => x.id === id)
      const first = list[0]
      const license = src?.license ?? first?.license
      const commit = shortCommit(src?.commit ?? first?.sourceCommit)
      // Core is 'Built in'; imports carry their own per-skill licences, so the group shows none.
      const meta = id === 'core' ? 'Built in' : id === 'custom' ? '' : [license, commit ? `pinned @ ${commit}` : ''].filter(Boolean).join(' · ')
      const matching = list
        .filter((s) => !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
        // Enabled first, then by name, so the collapsed view shows what's on.
        .sort((a, b) => Number(upFront.has(b.id)) - Number(upFront.has(a.id)) || a.name.localeCompare(b.name))
      return {
        id,
        title: SOURCE_TITLES[id] ?? src?.repo ?? first?.sourceRepo ?? id,
        readOnly: VENDORED_SOURCES.includes(id),
        meta,
        skills: matching,
        enabled: list.filter((s) => on.has(s.id)).length,
        // The source count covers skills not loaded; never less than what's here (e.g. right after an import).
        total: Math.max(src?.count ?? 0, list.length),
        note: GROUP_NOTES[id],
      }
    })
    .filter((g) => !q || g.skills.length > 0)
}

/** How many rows a collapsed group shows before "＋ N more". */
export const GROUP_PREVIEW = 3

export function visibleSkills(group: SkillGroup, expanded: boolean, query = ''): { rows: SkillSummary[]; more: number } {
  if (expanded || query.trim()) return { rows: group.skills, more: 0 }
  return { rows: group.skills.slice(0, GROUP_PREVIEW), more: Math.max(0, group.skills.length - GROUP_PREVIEW) }
}

/** New skillIds after a toggle: order kept, unknown ids (skills not in this list) untouched. */
export function toggleSkillId(ids: readonly string[], id: string, on: boolean): string[] {
  if (on) return ids.includes(id) ? [...ids] : [...ids, id]
  return ids.filter((x) => x !== id)
}

export function skillIdsDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[]; changed: boolean } {
  const added = after.filter((x) => !before.includes(x))
  const removed = before.filter((x) => !after.includes(x))
  return { added, removed, changed: added.length + removed.length > 0 }
}

export function compactTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`
}

export type BudgetMeter = { label: string; fraction: number; tone: 'ok' | 'warn' | 'bad' }

/** BE-7: the catalog is "too-large" past this share of the context window. */
export const CATALOG_SHARE = 0.25

/**
 * The token meter, against the usable window (context − reply reserve), as 03c's
 * "Catalog 3.6k of 16k tokens". BE-7 reports `catalogTokens` (the one-line skill
 * list); it warns from 80% of the 25%-of-window cap and BE `mode` decides
 * too-large. Older BEs only have the whole-prompt estimate.
 */
export function budgetMeter(b: PromptBudget): BudgetMeter {
  const usable = Math.max(1, b.contextWindow - b.responseReserve)
  if (typeof b.catalogTokens === 'number') {
    const cap = b.contextWindow * CATALOG_SHARE
    return {
      label: `Catalog ${compactTokens(b.catalogTokens)} of ${compactTokens(usable)} tokens`,
      fraction: Math.min(1, b.catalogTokens / usable),
      tone: b.mode === 'too-large' ? 'bad' : b.catalogTokens > cap * 0.8 ? 'warn' : 'ok',
    }
  }
  const fraction = Math.min(1, b.estimatedTokens / usable)
  return {
    label: `Prompt ≈${compactTokens(b.estimatedTokens)} of ${compactTokens(usable)} tokens`,
    fraction,
    tone: b.mode === 'too-large' ? 'bad' : fraction > 0.8 ? 'warn' : 'ok',
  }
}

/**
 * Error text for a skill write (PATCH/DELETE/import). Vendored skills answer 403;
 * say so plainly unless the server already gave a specific reason.
 */
export function skillWriteError(err: unknown, fallback: string): string {
  const status = (err as { status?: unknown } | null)?.status
  const msg = err instanceof Error ? err.message.trim() : ''
  if (status === 403) {
    return msg && !/^(forbidden|request (error|failed))$/i.test(msg)
      ? msg
      : 'Vendored skills are read-only: they come from a pinned upstream copy. Import your own SKILL.md to change one.'
  }
  return msg || fallback
}

/**
 * Catalog after an import: the skill replaces any row with its id, and its
 * source's count follows (an entry is added if the server had none yet).
 */
export function withImportedSkill(c: SkillsResponse, skill: SkillSummary): SkillsResponse {
  const had = c.skills.some((s) => s.id === skill.id)
  const sid = skillSourceId(skill)
  const skills = [...c.skills.filter((s) => s.id !== skill.id), skill]
  if (had || c.legacy) return { ...c, skills }
  const found = c.sources.some((s) => s.id === sid)
  const sources = found
    ? c.sources.map((s) => (s.id === sid ? { ...s, count: s.count + 1 } : s))
    : [...c.sources, { id: sid, repo: null, commit: null, license: null, count: 1 }]
  return { ...c, skills, sources }
}
