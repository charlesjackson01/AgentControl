/*
 * FE-7 part 1: what an assistant message's `activity` (BE-7 normalizeChatMessages)
 * shows: a collapsible skill/steps card above the bubble and file cards below it
 * (mockups 04, 05b). Pure; tests/activity.test.mjs.
 *
 * The BE already drops malformed entries and keeps at most 20 steps; this repeats
 * both so an older or newer server can't break the thread.
 */
import type { ActivatedSkill, MessageActivity } from './types'
import { humanSize, relativeTime } from './file-format.ts'
import { chatPanelPath } from './commands.ts'

export const MAX_STEPS = 20

/** `target` is the mono part after the verb: the step's path, or the tool name for tools without a verb ("Ran convert_units"). */
export type ActivityStep = { tool: string; verb: string; target: string | null; summary: string; ok: boolean; path?: string }
/** `meta` is the line under the name: "workspace/briefs · 2.4 KB · updated just now" (04), or "workspace/briefs · modified" without BE-3 fields. */
export type ActivityFile = { path: string; name: string; dir: string; change: 'added' | 'modified'; changeLabel: string; size: string | null; updated: string | null; meta: string }

/*
 * Mockup gaps (not shown in v3 04/05b; minimal neutral versions, pending Charles):
 *   GAP-1 failed step: ✕ instead of ✓, no colour, no "failed" count.
 *   GAP-2 default state: collapsed (05b) rather than expanded (04).
 *   GAP-3 a skill with no steps: header only, no count, no toggle.
 *   GAP-4 steps with no skill: no pill or name, just the count and toggle.
 *   GAP-5 several skills: names joined in the header; sources listed in the body.
 *   GAP-6 file cards: resolved by BE-3 (`bytes`, `modifiedAt`): "folder · 2.4 KB · updated just now"
 *         as in mockup 04. Until BE-3 lands, entries without them keep "folder · modified".
 *   GAP-7 resolved (FE-4): Open links to the Files panel at the file's path (fileOpenPath); Download left out.
 *   GAP-8 20-step cap: rows simply stop at 20, no "more" line.
 *   GAP-9 a message with only files: file cards, no skill card.
 */
export type ActivityView = {
  skills: ActivatedSkill[]
  steps: ActivityStep[]
  failed: number
  files: ActivityFile[]
  /** Whether the skill/steps card shows at all (files alone only get file cards, GAP-9). */
  card: boolean
  /** Whether the card has anything to expand: steps, or the sources of several skills (GAP-3, GAP-5). */
  expandable: boolean
  /** Header pill "Skill" (mockup 04), or null when the run activated none (GAP-4). */
  pill: string | null
  /** Header title: skill names (mockup 04: one; GAP-5: several joined), or null. */
  title: string | null
  /** Source next to the title (mockup 04), only when there is exactly one skill. */
  source: string | null
  /** Right side of the header, "5 steps" (mockup 04), or '' with no steps (GAP-3). */
  count: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** Past-tense label for a tool, as in mockup 04 ("Read", "Edited", "Ran"). Unknown tools show their name. */
const VERBS: Record<string, string> = {
  activate_skill: 'Activated skill',
  read_skill_file: 'Read skill file',
  get_skill: 'Activated skill',
  read_file: 'Read',
  read_text_file: 'Read',
  list_files: 'Listed',
  list_directory: 'Listed',
  search_files: 'Searched',
  write_file: 'Wrote',
  create_file: 'Created',
  edit_file: 'Edited',
  append_file: 'Edited',
  delete_file: 'Deleted',
  move_file: 'Moved',
  view_image: 'Looked at',
  run_script: 'Ran',
  run_command: 'Ran',
  web_search: 'Searched the web',
  fetch_url: 'Fetched',
  // BE-4: the notes tools were retired; memory tools replace them.
  remember: 'Remembered',
  recall: 'Recalled',
  compare_text: 'Compared',
  diff_text: 'Compared',
}

/** Verb and mono target for a step: known tools read "Read <path>", others "Ran <tool>". */
export function stepVerb(tool: string, path?: string): { verb: string; target: string | null } {
  const verb = VERBS[tool]
  return verb ? { verb, target: path ?? null } : { verb: 'Ran', target: tool }
}

function skillsOf(raw: unknown): ActivatedSkill[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap((s): ActivatedSkill[] => {
    if (!isObj(s) || !str(s.id) || !str(s.name) || typeof s.source !== 'string' || seen.has(s.id)) return []
    seen.add(s.id)
    return [{ id: s.id, name: s.name, source: s.source }]
  })
}

function stepsOf(raw: unknown): ActivityStep[] {
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap((s): ActivityStep[] =>
      isObj(s) && str(s.tool) && typeof s.summary === 'string' && typeof s.ok === 'boolean'
        ? [{ tool: s.tool, ...stepVerb(s.tool, str(s.path) ? s.path : undefined), summary: s.summary, ok: s.ok, ...(str(s.path) ? { path: s.path } : {}) }]
        : [],
    )
    .slice(0, MAX_STEPS)
}

function filesOf(raw: unknown, now: Date): ActivityFile[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((f): ActivityFile[] => {
    if (!isObj(f) || !str(f.path) || (f.change !== 'added' && f.change !== 'modified')) return []
    const path = f.path.replace(/\/+$/, '')
    const cut = path.lastIndexOf('/')
    const dir = cut === -1 ? '' : path.slice(0, cut)
    const size = humanSize(f.bytes)
    const rel = relativeTime(f.modifiedAt, now)
    const updated = rel ? `updated ${rel}` : null
    // Mockup 04 when BE-3 sends bytes/modifiedAt; otherwise today's "folder · modified".
    const meta = (size || updated ? [dir, size, updated] : [dir, f.change]).filter(Boolean).join(' · ')
    return [{ path, name: cut === -1 ? path : path.slice(cut + 1), dir, change: f.change, changeLabel: f.change, size, updated, meta }]
  })
}

/** The view for one message's activity, or null when there is nothing to show. */
export function activityView(activity: MessageActivity | unknown, now: Date = new Date()): ActivityView | null {
  if (!isObj(activity)) return null
  const skills = skillsOf(activity.skills)
  const steps = stepsOf(activity.steps)
  const files = filesOf(activity.filesChanged, now)
  if (skills.length + steps.length + files.length === 0) return null
  const failed = steps.filter((s) => !s.ok).length
  return {
    skills,
    steps,
    failed,
    files,
    card: skills.length + steps.length > 0,
    expandable: steps.length > 0 || skills.length > 1,
    pill: skills.length > 0 ? 'Skill' : null,
    title: skills.length > 0 ? skills.map((s) => s.name).join(', ') : null,
    source: skills.length === 1 ? skills[0].source || null : null,
    count: steps.length > 0 ? plural(steps.length, 'step') : '',
  }
}

/** Screen-reader name for the card's header, e.g. "Skill systematic-debugging, 5 steps, 1 failed". */
export function activityLabel(v: ActivityView): string {
  return [
    v.title ? `Skill ${v.title}` : null,
    v.count || null,
    v.failed > 0 ? `${v.failed} failed` : null,
  ].filter(Boolean).join(', ')
}

/** FE-7 file card Open (GAP-7 resolved): this chat's Files panel, picking out `path` in its folder. */
export function fileOpenPath(conversationId: string, path: string): string {
  return chatPanelPath(conversationId, 'files', { path })
}
