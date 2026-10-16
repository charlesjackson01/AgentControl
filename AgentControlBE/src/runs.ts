/**
 * One agent run: prompt planning, the bounded tool loop, the context budget
 * and the stored audit record. POST /api/agents/:id/runs is a thin wrapper
 * around runAgent; project tasks (src/projects.ts) call executeRun with a
 * projectId.
 */
import { recordRunMessages } from './conversations.js'
import { fail, uid } from './http.js'
import { agentInstructions, attachedSkills, planPrompt, RESPONSE_RESERVE } from './prompt.js'
import type { Agent, AgentRun } from './shared/types.js'
import type { WorkspaceStore } from './store.js'
import { executeToolCall, type ToolContext, type ToolOutcome } from './tools.js'
import { chatCompletion, STOPPED_BY_YOU, type ChatMessage, type ChatResult, type ToolDeclaration } from './upstream.js'

export interface RunOptions {
  /**
   * Set for project task runs. The run records it, and only earlier runs of
   * the same project become history; a run without it never sees project runs.
   */
  projectId?: string
  /**
   * Optional abort signal (orchestration Part 2). Checked before each upstream
   * and tool call; an aborted run is stored as failed with "Stopped by you"
   * and keeps any toolCalls already recorded.
   */
  signal?: AbortSignal
}

/** Runs kept per agent and scope (its own chat, or one project). */
export const RUNS_PER_SCOPE = 50

export interface RunOutcome {
  run: AgentRun
  /** False when store.save() failed: the run is in memory but not on disk yet. */
  persisted: boolean
}

/**
 * Run `agent` on `input` (already trimmed) and store the run. Throws fail()
 * errors: 400 no endpoint, 413 prompt too large, 500 when a successful run
 * could not be persisted. Upstream failures come back as a failed run.
 */
export async function runAgent(
  store: WorkspaceStore,
  agent: Agent,
  input: string,
  opts: RunOptions = {},
): Promise<AgentRun> {
  const { run, persisted } = await executeRun(store, agent, input, opts)
  // Never report a successful run as stored when the write actually failed.
  if (!persisted && run.status === 'succeeded') {
    fail(500, 'Run completed but its result could not be persisted.')
  }
  return run
}

/**
 * runAgent for internal callers: the same run and the same 400/413 errors,
 * but a failed save is reported in `persisted` instead of thrown. The run
 * stays in the store, so the caller's next successful save persists it.
 */
export async function executeRun(
  store: WorkspaceStore,
  agent: Agent,
  input: string,
  opts: RunOptions = {},
): Promise<RunOutcome> {
  if (!input) fail(400, 'Provide an "input" string to run the agent.')
  const projectId = opts.projectId

  // Every agent has an endpoint; no hosted fallback exists.
  const endpoint = store.endpoints.find((e) => e.id === agent.endpointId)
  if (!endpoint) fail(400, `Agent "${agent.name}" has no valid endpoint. Pick one in its settings.`)
  const baseUrl = endpoint.baseUrl
  const apiKey = store.endpointKeys[endpoint.id]
  const timeoutMs = endpoint.timeoutMs ?? 30_000

  // System prompt = instructions + the full CONTENT of attached skills, or,
  // when that leaves too little of the window, summaries of the largest
  // skills plus get_skill to read them (see planPrompt). Offered tools are
  // the registry tools the skills declare; only these may execute.
  // Empty => no `tools` key upstream (pre-tool runs stay byte-identical).
  const injectedSkills = attachedSkills(store.skills, agent.skillIds)
  const plan = planPrompt({
    instructions: agentInstructions(agent.instructions, agent.rules),
    skills: injectedSkills,
    input,
    contextWindow: endpoint.contextWindow,
  })
  const system = plan.system
  const toolDeclarations: ToolDeclaration[] = plan.toolDeclarations
  const summarized = new Set(plan.summarizedSkillIds)
  // get_skill the planner added (no attached skill declares it) reads only
  // this agent's skills, not every skill in the workspace.
  const plannerGetSkill =
    summarized.size > 0 && !injectedSkills.some((s) => (s.tools ?? []).some((t) => t.name === 'get_skill'))
  const sendTools = toolDeclarations.length > 0 ? toolDeclarations : undefined
  const toolSchemaChars = sendTools ? JSON.stringify(sendTools).length : 0

  // Prior turns: the most recent successful runs become user/assistant pairs
  // (oldest first). Placeholder seed runs with empty text are skipped. A
  // project task sees only runs of the same project; the agent's own chat
  // never sees project runs.
  const history = store.runs
    .filter(
      (r) =>
        r.agentId === agent.id &&
        r.projectId === projectId &&
        r.status === 'succeeded' &&
        r.input.trim() !== '' &&
        r.output.trim() !== '',
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 10)
    .reverse()

  // Context budget: a crude chars/4 estimate (no tokenizer dep) checked against
  // the endpoint's context window. Reserve room for the response, then drop the
  // oldest history turns until the prompt fits. The system prompt + this input
  // can't be trimmed, so if they alone overflow, reject with 413. Tool results
  // count toward the estimate and the whole check re-runs each loop iteration.
  // Tool-call turns (assistant content + call arguments) and tool results
  // count too, as do the tool schemas on calls that send them.
  const contextWindow = endpoint.contextWindow
  let loopChars = 0
  const estimate = (turns: AgentRun[], withSchemas: boolean): number => {
    let chars = system.length + input.length + loopChars + (withSchemas ? toolSchemaChars : 0)
    for (const t of turns) chars += t.input.length + t.output.length
    return Math.ceil(chars / 4)
  }

  // Tool loop: bounded by MAX_TOOL_ITERATIONS tool-enabled calls, then one
  // final tools-off call. Unknown tools / bad JSON come back as tool messages
  // so the model can recover; they never 500 the run.
  // Per-run caps keep one looping model from flooding the store or the
  // event loop; over-cap calls are still answered (every tool_call_id must be).
  const MAX_TOOL_ITERATIONS = 4
  const MAX_CALLS_PER_TURN = 8
  const MAX_CALLS_PER_RUN = 16
  const TOOL_RESULT_MAX_CHARS = 4_000
  const MIN_TOOL_RESULT_CHARS = 300
  const AUDIT_ARGUMENT_MAX_CHARS = 1_000
  const DIRECT_ANSWER_INSTRUCTION =
    'Tool use is no longer available. Answer the user directly in plain text now.'

  const loopMessages: ChatMessage[] = []
  const toolAudit: NonNullable<AgentRun['toolCalls']> = []
  let totalLatency = 0
  let steps = 0
  let exhausted = false
  let contextExhausted = false
  let forceFinal = false
  let callsThisRun = 0
  let result: ChatResult | undefined

  const runId = uid('run')
  const toolCtx: ToolContext = {
    store,
    agentId: agent.id,
    ...(projectId !== undefined ? { projectId } : {}),
    runId,
    input,
    allowed: new Set(toolDeclarations.map((t) => t.name)),
    now: () => new Date(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    writes: { count: 0 },
    ...(plannerGetSkill ? { skillScope: new Set(injectedSkills.map((s) => s.id)) } : {}),
  }

  const signal = opts.signal
  const startedAt = new Date().toISOString()
  for (let iteration = 0; ; iteration++) {
    if (signal?.aborted) {
      result = { ok: false, content: '', latencyMs: 0, error: STOPPED_BY_YOU }
      break
    }
    const finalCall = iteration >= MAX_TOOL_ITERATIONS || forceFinal
    const withSchemas = !finalCall && sendTools !== undefined
    const systemText =
      finalCall && system ? `${system}\n\n${DIRECT_ANSWER_INSTRUCTION}` : system

    let turns = history
    let estimated = estimate(turns, withSchemas)
    while (estimated + RESPONSE_RESERVE > contextWindow && turns.length > 0) {
      turns = turns.slice(1)
      estimated = estimate(turns, withSchemas)
    }
    const baseEstimated = estimate([], withSchemas)
    if (baseEstimated + RESPONSE_RESERVE > contextWindow) {
      if (toolAudit.length === 0) {
        fail(
          413,
          `Prompt too large for this endpoint's context window: about ${baseEstimated} tokens of prompt ` +
            `plus ${RESPONSE_RESERVE} reserved for the reply exceed the ${contextWindow}-token window. ` +
            "Detach skills, shorten the instructions or the message, or raise the endpoint's context window in Settings.",
        )
      }
      // Tools already ran (and may have written notes): never drop the run.
      // Retry as the tools-off final call; if even that overflows, record a failure.
      if (!finalCall) {
        forceFinal = true
        continue
      }
      contextExhausted = true
      break
    }
    const maxTokens = Math.min(RESPONSE_RESERVE, contextWindow - estimated)

    const messages: ChatMessage[] = []
    if (systemText) messages.push({ role: 'system', content: systemText })
    for (const turn of turns) {
      messages.push({ role: 'user', content: turn.input })
      messages.push({ role: 'assistant', content: turn.output })
    }
    messages.push({ role: 'user', content: input })
    messages.push(...loopMessages)

    result = await chatCompletion(
      baseUrl,
      apiKey,
      agent.modelId,
      messages,
      timeoutMs,
      maxTokens,
      finalCall ? undefined : sendTools,
      agent.temperature,
      signal,
      endpoint.proxyUrl,
    )
    steps += 1
    totalLatency += result.latencyMs

    if (!result.ok) break
    if (result.toolCalls && result.toolCalls.length > 0) {
      if (finalCall) {
        exhausted = true
        break
      }
      loopMessages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls })
      loopChars += result.content.length
      for (const call of result.toolCalls) loopChars += call.name.length + call.arguments.length
      let callsThisTurn = 0
      for (const call of result.toolCalls) {
        if (signal?.aborted) {
          result = { ok: false, content: '', latencyMs: 0, error: STOPPED_BY_YOU }
          break
        }
        callsThisTurn += 1
        // What the context window still holds for this result. Paging tools
        // size their page to it; anything larger is clipped below.
        const remainingChars = (contextWindow - RESPONSE_RESERVE - estimate([], true)) * 4
        const limit = Math.min(TOOL_RESULT_MAX_CHARS, remainingChars - 400)
        toolCtx.resultMaxChars = limit
        let outcome: ToolOutcome
        if (callsThisTurn > MAX_CALLS_PER_TURN || callsThisRun >= MAX_CALLS_PER_RUN) {
          outcome = {
            ok: false,
            content: `Too many tool calls: at most ${MAX_CALLS_PER_TURN} per turn and ${MAX_CALLS_PER_RUN} per run. Answer with what you have.`,
          }
        } else {
          callsThisRun += 1
          outcome = await executeToolCall(call, toolCtx)
        }
        // Clip to what the context window still holds; when almost nothing is
        // left, say so and make the next call the tools-off final call.
        let content = outcome.content
        let ok = outcome.ok
        if (content.length > limit) {
          if (limit < MIN_TOOL_RESULT_CHARS) {
            content = 'Context budget exhausted; answer with what you have.'
            ok = false
            forceFinal = true
          } else {
            const marker = '…[truncated]'
            content = `${content.slice(0, Math.max(0, limit - marker.length))}${marker}`
          }
        }
        loopChars += content.length
        loopMessages.push({ role: 'tool', content, toolCallId: call.id })
        toolAudit.push({
          name: call.name,
          arguments:
            call.arguments.length > AUDIT_ARGUMENT_MAX_CHARS
              ? `${call.arguments.slice(0, AUDIT_ARGUMENT_MAX_CHARS)}…[truncated]`
              : call.arguments,
          resultChars: content.length,
          ok,
        })
      }
      if (!result.ok) break
      continue
    }
    break
  }

  const upstream = result as ChatResult
  const failed = exhausted || contextExhausted || !upstream.ok
  const run: AgentRun = {
    id: runId,
    agentId: agent.id,
    startedAt,
    status: failed ? 'failed' : 'succeeded',
    durationMs: totalLatency,
    steps,
    input,
    output: failed ? '' : upstream.content,
    error: failed
      ? exhausted
        ? `Tool-call loop exhausted after ${MAX_TOOL_ITERATIONS} iterations; the model kept requesting tools.`
        : contextExhausted
          ? "Context exhausted by tool results: the conversation no longer fits this endpoint's context window."
          : (upstream.error ?? 'Request failed')
      : null,
    // Audit: exactly what went upstream. Failed runs record it too —
    // injection happens before the upstream call.
    systemPrompt: system,
    skillSnapshot: injectedSkills.map((s) => ({
      id: s.id,
      name: s.name,
      contentChars: s.content.length,
      mode: summarized.has(s.id) ? ('summary' as const) : ('full' as const),
    })),
    ...(toolAudit.length > 0 ? { toolCalls: toolAudit } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  }

  // Prepend, then trim this agent's runs in this scope (its own chat, or this
  // project) to the newest RUNS_PER_SCOPE, so project work never pushes the
  // agent's chat transcript out, nor one project another's.
  store.runs = [run, ...store.runs]
  const scoped = store.runs.filter((r) => r.agentId === agent.id && r.projectId === projectId)
  if (scoped.length > RUNS_PER_SCOPE) {
    const drop = new Set(scoped.slice(RUNS_PER_SCOPE).map((r) => r.id))
    store.runs = store.runs.filter((r) => !drop.has(r.id))
  }
  // Chat-first: 1:1 runs also land in the agent's DM (kept past run pruning).
  recordRunMessages(store, run)
  agent.lastRunAt = run.startedAt
  agent.runCount += 1
  agent.status = run.status === 'succeeded' ? 'idle' : 'error'
  return { run, persisted: store.save() }
}
