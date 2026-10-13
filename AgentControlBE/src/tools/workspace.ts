/**
 * Workspace introspection tools (read-only). Never return endpoint URLs,
 * cached model lists, API keys, the auth token, run system prompts or
 * tool-call arguments: results may be sent to a hosted provider.
 */
import type { Agent, AgentRun, Endpoint, Skill } from '../shared/types.js'
import type { WorkspaceStore } from '../store.js'
import { argError, findAgent, findSkillIn, readNumber, readString } from './args.js'
import { clipJsonText, clipText, fitJson, pageJsonBudget, pageText, type TextPage } from './limits.js'
import { REDACTED, redactSecrets } from './redact.js'
import type { ToolContext, ToolEntry } from './types.js'

const NO_PARAMS = { type: 'object', properties: {}, additionalProperties: false }

/** Run text (input, output, error) as read_run_log shows it: redacted, then clipped. */
function runText(value: unknown, store: WorkspaceStore): unknown {
  return typeof value === 'string' ? safeText(value, 500, store) : value
}

// --- get_agent / get_skill / workspace_overview helpers ---------------------

/** Longest agent or skill reference accepted (ids and names are short). */
const REF_MAX = 200
/** get_skill content page, in chars; it shrinks to keep the whole result under RESULT_MAX_CHARS. */
const SKILL_PAGE_CHARS = 2_500
/** Decision 14: an agent's instructions are clipped before they go upstream. */
const INSTRUCTIONS_MAX = 1_500
/** workspace_overview counts failures among each agent's newest N runs. */
const RECENT_RUNS = 10
/** get_agent lists at most this many skill and tool names (totals reported beyond). */
const MAX_SKILL_NAMES = 20
const MAX_TOOL_NAMES = 30
/**
 * get_agent reads at most this many of an agent's skill ids, and this many
 * tools per skill (the skills API allows 16). The API does not bound
 * skillIds, and a 1 MiB body holds ~250k of them; an agent with more than a
 * handful could never run anyway (every attached skill's content goes into
 * its prompt).
 */
const MAX_SKILL_SCAN = 200
const MAX_TOOLS_PER_SKILL = 16
/** workspace_overview lists at most this many agents and endpoints (counts stay exact). */
const MAX_OVERVIEW_ROWS = 50
/**
 * workspace_overview reads at most this many runs. The app keeps runs newest
 * first (it prepends) and at most 50 per agent, so this is 2,000 agents' full
 * history; it only bounds the time on absurd stores (1M runs took ~60 ms).
 */
const MAX_RUN_SCAN = 100_000
/**
 * Stored text is read this far past a field's clip point, so a secret (or
 * URL part) straddling the clip is still matched whole. Longer than any key.
 */
const SCAN_MARGIN = 4_096

const AGENT_EXAMPLE = { agentId: 'Researcher' }
/**
 * The schema name first, then the keys small models send instead
 * ({"name": "Researcher"}, {"agent_id": ...}). An ignored alias would
 * silently describe the caller instead of the agent it asked about.
 */
const AGENT_REF_KEYS = ['agentId', 'agent_id', 'agent', 'agentName', 'agent_name', 'name', 'id'] as const
const SKILL_EXAMPLE = { skill: 'code-review' }
/** Same idea for skills: "skill" first, then {"skillId": ...}, {"name": ...} and friends. */
const SKILL_REF_KEYS = ['skill', 'skillId', 'skill_id', 'id', 'name'] as const
/** Same shape the skills API accepts; anchored with one bounded quantifier (linear). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** Stored data is user/legacy-shaped; never trust a field to be a string. */
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' ? clipText(v, 40) : null)
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** clipText that never leaves half a surrogate pair in front of the "…". */
function clipSafe(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/**
 * `transform` (match-and-replace passes) applied to a prefix of `text` long
 * enough that its first `keep` chars are what transforming the whole text
 * would give: a match cut by the prefix end sits within SCAN_MARGIN of the
 * result's end. When replacements shrink the result below keep + SCAN_MARGIN
 * the prefix doubles, so the work stays linear and bounded for long fields.
 */
function boundedPrefix(text: string, keep: number, transform: (s: string) => string): string {
  let end = Math.min(text.length, keep + SCAN_MARGIN)
  let out = transform(text.slice(0, end))
  while (end < text.length && out.length < keep + SCAN_MARGIN) {
    end = Math.min(text.length, end * 2)
    out = transform(text.slice(0, end))
  }
  return out
}

/**
 * User-written text, redacted BEFORE it is clipped. executeToolCall redacts
 * exact secret values, but a clip that cuts through a pasted key leaves a
 * prefix nothing can match any more (decision 14). Exported for notes.ts.
 */
export function safeText(value: unknown, max: number, store: WorkspaceStore): string {
  return clipSafe(boundedPrefix(str(value), max, (s) => redactSecrets(s, store)), max)
}

/** First non-blank reference among `keys` (own keys only, via readString). */
function readRef(args: Record<string, unknown>, keys: readonly string[], example: Record<string, unknown>): string | undefined {
  for (const key of keys) {
    const value = readString(args, key, { max: REF_MAX, example })?.trim()
    if (value) return value
  }
  return undefined
}

function readAgentRef(args: Record<string, unknown>): string | undefined {
  return readRef(args, AGENT_REF_KEYS, AGENT_EXAMPLE)
}

/**
 * Not-found error listing up to 10 known agent names. Small models copy the
 * example verbatim, so it names a real agent (one whose name survived
 * clipping and redaction) rather than a generic "Researcher".
 */
function agentNotFound(ref: string | undefined, store: WorkspaceStore): Error {
  const agents = store.agents.slice(0, 10)
  const names = agents.map((a) => safeText(a.name, 40, store))
  const listed = names.length === 0 ? 'none' : names.map((n) => JSON.stringify(n)).join(', ')
  const more = store.agents.length > 10 ? ', …' : ''
  const usable = names.find((n, i) => n.trim() !== '' && n === agents[i]?.name)
  const lead = ref === undefined ? 'The current agent no longer exists; pass "agentId".' : `No agent "${safeText(ref, 60, store)}".`
  return argError(`${lead} Known agents: ${listed}${more}.`, usable ? { agentId: usable } : AGENT_EXAMPLE)
}

/** A skill name the model can copy into get_skill: unchanged by redaction and clipping. */
function usableSkillName(store: WorkspaceStore): string | undefined {
  for (const skill of store.skills.slice(0, 10)) {
    const name = str(skill?.name)
    if (name.trim() !== '' && safeText(name, 40, store) === name) return name
  }
  return undefined
}

/** Missing or unknown skill: lists up to 10 known names, and an example naming a real one. */
function skillNotFound(ref: string | undefined, store: WorkspaceStore, pool: readonly Skill[] = store.skills): Error {
  const names = pool.slice(0, 10).map((s) => JSON.stringify(safeText(s?.name, 40, store)))
  const listed = names.length === 0 ? 'none' : `${names.join(', ')}${pool.length > 10 ? ', …' : ''}`
  const lead = ref === undefined ? '"skill" is required: a skill id or name from list_skills.' : `No skill "${safeText(ref, 60, store)}".`
  const usable = usableSkillName(store)
  return argError(`${lead} Known skills: ${listed}.`, usable ? { skill: usable } : SKILL_EXAMPLE)
}

/** ASCII-only lowercase: same length as the input, so indexes map back to the original. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** Replace every ASCII-case-insensitive occurrence of `needle` (indexOf only; no RegExp built from data). */
function maskAll(text: string, needle: string, mask: string): string {
  if (needle.length === 0 || needle.length > text.length) return text
  const hay = asciiLower(text)
  const want = asciiLower(needle)
  let out = ''
  let from = 0
  for (let at = hay.indexOf(want); at !== -1; at = hay.indexOf(want, from)) {
    out += text.slice(from, at) + mask
    from = at + want.length
  }
  return from === 0 ? text : out + text.slice(from)
}

/**
 * Parts of an endpoint's baseUrl a label must not repeat, longest first:
 * the URL itself, host:port, the hostname (also without IPv6 brackets) and
 * any userinfo. Dotted or colon hosts only, at least 4 chars: masking
 * "localhost" or "llama" would mangle ordinary labels.
 */
function urlParts(baseUrl: string): { text: string; mask: string }[] {
  const parts: { text: string; mask: string }[] = []
  if (baseUrl.length >= 4) parts.push({ text: baseUrl, mask: '[url]' })
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return parts
  }
  const hostname = url.hostname
  if (hostname.length >= 4 && (hostname.includes('.') || hostname.includes(':'))) {
    parts.push({ text: url.host, mask: '[host]' }, { text: hostname, mask: '[host]' })
    if (hostname.startsWith('[')) parts.push({ text: hostname.slice(1, -1), mask: '[host]' })
  }
  for (const part of [url.username, url.password]) {
    if (part.length < 4) continue
    parts.push({ text: part, mask: REDACTED })
    try {
      const decoded = decodeURIComponent(part)
      if (decoded !== part && decoded.length >= 4) parts.push({ text: decoded, mask: REDACTED })
    } catch {
      // Malformed percent-encoding: the raw form is masked above.
    }
  }
  return parts.sort((a, b) => b.text.length - a.text.length)
}

/**
 * Endpoint names are user labels. One that embeds the endpoint's own URL,
 * host or credentials would leak a LAN/Tailscale address (or a key) to a
 * hosted provider (decision 14), so those parts are masked case-insensitively
 * and any other token containing "://" becomes [url]. Secrets are redacted
 * before the clip (see safeText).
 */
function endpointLabel(ep: Endpoint, store: WorkspaceStore): string {
  const name = str(ep.name)
  if (name === '') return ''
  const parts = urlParts(str(ep.baseUrl))
  const mask = (text: string): string => {
    let out = redactSecrets(text, store)
    for (const part of parts) out = maskAll(out, part.text, part.mask)
    if (!out.includes('://')) return out
    return out
      .split(/(\s+)/)
      .map((token) => (token.includes('://') ? '[url]' : token))
      .join('')
  }
  return clipSafe(boundedPrefix(name, 80, mask), 80)
}

function currentAgent(ctx: ToolContext): Agent | undefined {
  return ctx.store.agents.find((a) => a.id === ctx.agentId)
}

/**
 * The agent's attached skills in skillIds order, deduped; ids of deleted
 * skills are skipped. Reads the first MAX_SKILL_SCAN ids only.
 */
function attachedSkills(agent: Agent, skills: readonly Skill[]): Skill[] {
  const ids = Array.isArray(agent.skillIds) ? agent.skillIds.slice(0, MAX_SKILL_SCAN) : []
  const wanted = new Set<string>(ids.filter((id): id is string => typeof id === 'string'))
  const byId = new Map<string, Skill>()
  for (const skill of skills) {
    const id = str(skill?.id)
    if (wanted.has(id) && !byId.has(id)) byId.set(id, skill)
  }
  const seen = new Set<string>()
  const out: Skill[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue
    seen.add(id)
    const skill = byId.get(id)
    if (skill) out.push(skill)
  }
  return out
}

/**
 * Tool names the skills declare, deduped in order. These are declarations as
 * stored, not this run's offered tools: the run loop offers only the ones the
 * registry knows. Malformed legacy names are skipped (length checked before
 * the regex runs).
 */
function declaredToolNames(skills: readonly Skill[]): string[] {
  const names = new Set<string>()
  for (const skill of skills) {
    const tools = Array.isArray(skill.tools) ? skill.tools.slice(0, MAX_TOOLS_PER_SKILL) : []
    for (const tool of tools) {
      const name = str((tool as { name?: unknown } | null)?.name)
      if (name.length <= 64 && TOOL_NAME.test(name)) names.add(name)
    }
  }
  return [...names]
}

/**
 * Failures among each listed agent's newest RECENT_RUNS runs. One pass over
 * the runs with a bounded insertion per agent (O(runs × 10), no full sort),
 * keyed by agent id in a Map so prototype-like ids are plain keys.
 */
function recentFailureCounts(agents: readonly Agent[], runs: readonly AgentRun[]): Map<string, number> {
  const newest = new Map<string, { at: string; failed: boolean }[]>()
  for (const agent of agents) newest.set(agent.id, [])
  const scan = Math.min(runs.length, MAX_RUN_SCAN)
  for (let r = 0; r < scan; r++) {
    const run = runs[r]
    if (!run) continue
    const list = newest.get(str(run.agentId))
    if (!list) continue
    const at = str(run.startedAt)
    // Newest first (ISO timestamps compare as plain strings); ties keep store order.
    let i = list.length
    while (i > 0 && list[i - 1]!.at < at) i--
    if (i >= RECENT_RUNS) continue
    list.splice(i, 0, { at, failed: run.status === 'failed' })
    if (list.length > RECENT_RUNS) list.pop()
  }
  const counts = new Map<string, number>()
  for (const [id, list] of newest) counts.set(id, list.filter((r) => r.failed).length)
  return counts
}

export const workspaceTools: ToolEntry[] = [
  {
    name: 'list_agents',
    category: 'workspace',
    effect: 'read',
    description:
      'List every agent in the workspace: id, name, role, whether it is the Team Lead (isPrimary), status, and model id. Example: {}',
    parameters: NO_PARAMS,
    // No fitJson: the run loop's clip is the backstop (pinned by a test).
    handler: (_args, ctx) =>
      ctx.store.agents.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        isPrimary: a.isPrimary,
        status: a.status,
        modelId: a.modelId,
      })),
  },
  {
    name: 'list_skills',
    category: 'workspace',
    effect: 'read',
    description: 'List every skill in the workspace with its id, name, and description. Example: {}',
    parameters: NO_PARAMS,
    // Redacted before any clip, ours or fitJson's (decision 14).
    handler: (_args, ctx) => fitJson(
      ctx.store.skills.map((s) => ({
        id: safeText(s.id, REF_MAX, ctx.store),
        name: safeText(s.name, REF_MAX, ctx.store),
        description: safeText(s.description, 100, ctx.store),
      })),
    ),
  },
  {
    name: 'read_run_log',
    category: 'workspace',
    effect: 'read',
    description:
      'Read recent runs for an agent (default: you), newest first: status, timing, input, output, error. Example: {"agentId": "Researcher", "limit": 3}',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id or name. Defaults to the current agent.' },
        limit: { type: 'number', description: 'Max runs to return, 1-10 (default 5).' },
      },
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const example = { agentId: 'Researcher', limit: 3 }
      const ref = readString(args, 'agentId', { max: 200, example })?.trim()
      let agentId = ctx.agentId
      if (ref) {
        const agent = findAgent(ctx.store, ref)
        if (!agent) throw argError(`No agent "${safeText(ref, 60, ctx.store)}". Use list_agents for ids and names.`, example)
        agentId = agent.id
      }
      const requested = readNumber(args, 'limit', { example }) ?? 5
      const limit = Math.min(Math.max(Math.floor(requested), 1), 10)
      return ctx.store.runs
        .filter((r) => r.agentId === agentId)
        // D-O10: a project-task run reads only its own project's runs.
        .filter((r) => ctx.projectId === undefined || r.projectId === ctx.projectId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          status: r.status,
          startedAt: r.startedAt,
          durationMs: r.durationMs,
          input: runText(r.input, ctx.store),
          output: runText(r.output, ctx.store),
          error: runText(r.error, ctx.store),
        }))
    },
  },
  {
    name: 'get_agent',
    category: 'workspace',
    effect: 'read',
    description:
      'Show one agent (default: you): role, description, instructions, endpoint name/kind/status/context window, model, skill names, tool names its skills declare, run count. Example: {"agentId": "Researcher"}',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent id or name. Defaults to the current agent.' },
      },
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const { store } = ctx
      const ref = readAgentRef(args)
      const agent = ref ? findAgent(store, ref) : currentAgent(ctx)
      if (!agent) throw agentNotFound(ref, store)
      const skills = attachedSkills(agent, store.skills)
      const tools = declaredToolNames(skills)
      const endpoint = store.endpoints.find((e) => e.id === agent.endpointId)
      const instructions = str(agent.instructions)

      // Free text goes through safeText (redact, then clip); enums and timestamps are machine-written.
      return fitJson({
        id: safeText(agent.id, 100, store),
        name: safeText(agent.name, 100, store),
        role: safeText(agent.role, 100, store),
        description: safeText(agent.description, 500, store),
        instructions: safeText(instructions, INSTRUCTIONS_MAX, store),
        ...(instructions.length > INSTRUCTIONS_MAX ? { instructionsChars: instructions.length } : {}),
        // No baseUrl, key or key flag, and no cached model list.
        endpoint: endpoint
          ? {
              name: endpointLabel(endpoint, store),
              kind: clipText(str(endpoint.kind), 40),
              status: clipText(str(endpoint.status), 40),
              contextWindow: numOrNull(endpoint.contextWindow),
            }
          : null,
        modelId: safeText(agent.modelId, 120, store),
        temperature: numOrNull(agent.temperature),
        skills: skills.slice(0, MAX_SKILL_NAMES).map((s) => safeText(s.name, 60, store)),
        ...(skills.length > MAX_SKILL_NAMES ? { skillsTotal: skills.length } : {}),
        tools: tools.slice(0, MAX_TOOL_NAMES),
        ...(tools.length > MAX_TOOL_NAMES ? { toolsTotal: tools.length } : {}),
        isPrimary: agent.isPrimary === true,
        status: clipText(str(agent.status), 40),
        runCount: numOrNull(agent.runCount) ?? 0,
        lastRunAt: isoOrNull(agent.lastRunAt),
      })
    },
  },
  {
    name: 'workspace_overview',
    category: 'workspace',
    effect: 'read',
    description:
      "Workspace snapshot: current time, each agent's status, run count and recent failures (of its last 10 runs), endpoint status and context windows, skill and note counts. Example: {}",
    parameters: NO_PARAMS,
    handler: (_args, ctx) => {
      const { store } = ctx
      // Rows are capped before any work (fitJson alone takes ~50 ms on 5,000 rows); counts stay exact.
      const agents = store.agents.slice(0, MAX_OVERVIEW_ROWS)
      const endpoints = store.endpoints.slice(0, MAX_OVERVIEW_ROWS)
      const capped: Record<string, number> = {}
      if (agents.length < store.agents.length) capped.agents = store.agents.length
      if (endpoints.length < store.endpoints.length) capped.endpoints = store.endpoints.length
      const failures = recentFailureCounts(agents, store.runs)

      const fitted = fitJson({
        now: ctx.now().toISOString(),
        timeZone: ctx.timeZone,
        agents: agents.map((a) => ({
          name: safeText(a.name, 80, store),
          role: safeText(a.role, 60, store),
          isPrimary: a.isPrimary === true,
          status: clipText(str(a.status), 40),
          lastRunAt: isoOrNull(a.lastRunAt),
          runCount: numOrNull(a.runCount) ?? 0,
          recentFailures: failures.get(a.id) ?? 0,
        })),
        // No baseUrl, key or key flag, and no cached model lists.
        endpoints: endpoints.map((e) => ({
          name: endpointLabel(e, store),
          kind: clipText(str(e.kind), 40),
          status: clipText(str(e.status), 40),
          lastCheckedAt: isoOrNull(e.lastCheckedAt),
          contextWindow: numOrNull(e.contextWindow),
          defaultModel: safeText(e.defaultModel, 120, store),
        })),
        counts: {
          agents: store.agents.length,
          endpoints: store.endpoints.length,
          skills: store.skills.length,
          notes: store.notes.length,
        },
        ...(Object.keys(capped).length > 0 ? { truncated: true, totals: capped } : {}),
      }) as Record<string, unknown>
      // fitJson's own totals only know the capped list lengths: report the real ones.
      const totals = fitted.totals
      if (Object.keys(capped).length > 0 && totals !== null && typeof totals === 'object') {
        fitted.totals = { ...(totals as Record<string, unknown>), ...capped }
      }
      return fitted
    },
  },
  {
    name: 'get_skill',
    category: 'workspace',
    effect: 'read',
    description:
      'Read one skill by id or name: description, tool names and its full instructions in pages; pass nextOffset to continue. Example: {"skill":"code-review"}',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill id or name (see list_skills).' },
        offset: { type: 'number', description: "Where to start reading: the previous page's nextOffset. Default 0." },
      },
      required: ['skill'],
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      const { store } = ctx
      const ref = readRef(args, SKILL_REF_KEYS, SKILL_EXAMPLE)
      // Offered by the prompt planner, get_skill reads only the agent's own skills.
      const scope = ctx.skillScope
      const pool = scope ? store.skills.filter((s) => scope.has(s.id)) : store.skills
      const skill = ref ? findSkillIn(pool, ref) : undefined
      if (!skill) throw skillNotFound(ref, store, pool)
      const offset = Math.floor(readNumber(args, 'offset', { min: 0, example: SKILL_EXAMPLE }) ?? 0)

      // The whole text is redacted before it is paged: offsets index the
      // redacted text, and a key straddling a page edge is gone before any cut.
      const content = redactSecrets(str(skill.content), store)
      // Short fields are bounded in JSON chars too, so the page always has room.
      const head = {
        id: clipJsonText(safeText(skill.id, 100, store), 100, 120),
        name: clipJsonText(safeText(skill.name, 100, store), 100, 120),
        description: clipJsonText(safeText(skill.description, 300, store), 300, 360),
        tools: declaredToolNames([skill]),
      }
      // The page gets what the rest of the result leaves under the cap (the
      // skeleton's "" is counted twice, and nextOffset: null may outgrow the
      // digits), so fitJson never clips it and nextOffset stays exact.
      const total = content.length
      const skeleton = JSON.stringify({ ...head, totalChars: total, offset: total, content: '', nextOffset: total }).length
      let page: TextPage
      try {
        page = pageText(content, offset, SKILL_PAGE_CHARS, pageJsonBudget(skeleton, ctx.resultMaxChars))
      } catch (err) {
        if (!(err instanceof RangeError)) throw err
        throw argError(`${err.message} Start at 0, or pass the previous page's nextOffset.`, {
          skill: safeText(skill.id, REF_MAX, store),
          offset: 0,
        })
      }
      return fitJson({
        ...head,
        totalChars: page.totalChars,
        offset: page.offset,
        content: page.content,
        nextOffset: page.nextOffset,
      })
    },
  },
]
