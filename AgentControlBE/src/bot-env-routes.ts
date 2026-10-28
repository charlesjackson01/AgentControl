/**
 * BE-P2-4: the bot VM tab routes on top of BotEnvService.
 *
 *   GET   /api/agents/:id/vm            → VmInfo
 *   PATCH /api/agents/:id/vm            → VmInfo (internetPolicy, permissions.browser, gvisor, env)
 *   POST  /api/agents/:id/vm/start      → VmInfo
 *   POST  /api/agents/:id/vm/stop       → VmInfo
 *   POST  /api/agents/:id/vm/reset      → VmInfo ({confirm:true}; M1: no backup)
 *   GET   /api/agents/:id/vm/tools      → VmToolsInfo
 *
 * Tool rebuild/rollback routes return a ScriptRun (kind tool_build) and arrive with the
 * run service (BE-P2-8/16); the service methods are here already.
 * Fields owned by later tasks (runtime probe, usage of volumes/memory, snapshots, runs,
 * browser download) carry neutral values until those land.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { BotEnvService, BotMount } from './bot-env.js'
import type { MountAllowList } from './isolation.js'
import { envListProblem } from './bot-env.js'
import { botRoot, folderBytes, quotaBytes } from './files.js'
import { groupRoot } from './group-files.js'
import { fail, failWithReason } from './http.js'
import {
  INTERNET_POLICIES,
  RUNTIME_MODES,
  VM_LIMITS,
  type Agent,
  type AgentVm,
  type EnvVar,
  type GroupConversation,
  type InternetPolicy,
  type RuntimeMode,
  type VmHostInfo,
  type VmInfo,
  type VmState,
  type VmToolsInfo,
} from './shared/types.js'
import type { WorkspaceStore } from './store.js'
import { BOT_PATHS } from './vm-images.js'

export const VM_PATCH_KEYS = ['internetPolicy', 'permissions', 'gvisor', 'env'] as const
export const BROWSER_NOT_YET = 'The browser arrives in a later update.'
export const EGRESS_NOT_AVAILABLE = 'Home network access isn\'t available in Phase 2.'
export const LIMITS_FIXED = `Limits are fixed: ${VM_LIMITS.memoryMb / 1024} GB memory, ${VM_LIMITS.cpus} CPUs and ${VM_LIMITS.timeoutSec / 60} minutes per run.`

/** Bind mounts for a bot: workspace (rw), its inputs (ro) and the shared folder of each group it's in (rw). */
export function botMounts(store: WorkspaceStore, agent: Agent): BotMount[] {
  const root = botRoot(store, agent)
  const mounts: BotMount[] = [
    { source: path.join(root, 'workspace'), target: BOT_PATHS.workspace, readonly: false },
    { source: path.join(root, 'shared'), target: BOT_PATHS.inputs, readonly: true },
  ]
  for (const c of store.conversations) {
    if (c.kind !== 'group' || c.archivedAt || !c.memberAgentIds.includes(agent.id)) continue
    const shared = path.join(groupRoot(store, c.slug), 'shared')
    if (existsSync(shared)) mounts.push({ source: shared, target: `${BOT_PATHS.groups}/${c.slug}`, readonly: false })
  }
  return mounts
}

const memberGroups = (store: WorkspaceStore, agent: Agent): GroupConversation[] =>
  store.conversations.filter((c): c is GroupConversation => c.kind === 'group' && !c.archivedAt && c.memberAgentIds.includes(agent.id))

/**
 * BE-P2-5: what a bot may mount, for the mount guard (isolation.ts checkBotMounts): its own
 * workspace and inputs (inside its own folder) and the shared folder of each group it's in.
 */
export function botMountAllowList(store: WorkspaceStore, agent: Agent): MountAllowList {
  const root = botRoot(store, agent)
  const groups: Record<string, string> = {}
  let groupsRoot: string | undefined
  for (const c of memberGroups(store, agent)) {
    const g = groupRoot(store, c.slug)
    groups[c.slug] = path.join(g, 'shared')
    groupsRoot ??= path.dirname(g)
  }
  return { slug: agent.slug, workspace: path.join(root, 'workspace'), inputs: path.join(root, 'shared'), groups, botRoot: root, ...(groupsRoot ? { groupsRoot } : {}) }
}

export interface BotEnvRouteDeps {
  botEnv: BotEnvService
  hostInfo: () => Promise<VmHostInfo>
  /** BE-P2-8: the bot's resolved runtime (plan §4 table + limitsEnforced). */
  runtime?: (agent: Agent) => VmInfo['runtime']
  /** BE-P2-8: stop/reset end the bot's runs; idleStopAt for VmInfo. */
  runner?: { stopRuns(agentId: string): void; idleStopAt(agentId: string): string | undefined }
  /** BE-P2-5: VmInfo.isolationNote (e.g. the keep-id fallback), or undefined. */
  isolationNote?: (agent: Agent, engine: VmHostInfo['engine'] | null) => string | undefined
}

export function registerBotEnvRoutes(app: FastifyInstance, store: WorkspaceStore, deps: BotEnvRouteDeps): void {
  const { botEnv } = deps
  const agentOf = (id: string): Agent => {
    const agent = store.agents.find((a) => a.id === id)
    if (!agent) fail(404, `No agent with id "${id}"`)
    return agent
  }
  const filesMissing = (agent: Agent) => !existsSync(path.join(botRoot(store, agent), 'workspace'))

  async function vmInfo(agent: Agent): Promise<VmInfo> {
    const host = await deps.hostInfo().catch(() => null)
    let state: VmState = 'not_setup'
    let stateMessage: string | undefined
    if (filesMissing(agent)) {
      state = 'files_missing'
      stateMessage = 'The bot\'s files folder is missing.'
    } else if (!host?.engine) {
      stateMessage = host?.setupSteps.find((s) => !s.done)?.text ?? 'Podman isn\'t installed yet.'
    } else {
      try {
        const st = await botEnv.status(agent)
        state = st.state === 'missing' ? 'not_setup' : st.state
      } catch (err) {
        state = 'error'
        stateMessage = (err as Error).message
      }
    }
    const root = botRoot(store, agent)
    const workspace = folderBytes(path.join(root, 'workspace'))
    const inputs = folderBytes(path.join(root, 'shared'))
    const memory = folderBytes(path.join(root, 'memory'))
    const breakdown = { workspace, inputs, memory, tools: 0, opt: 0, imageLayer: 0 }
    const globalMode = store.settings.vm?.gvisor ?? 'auto'
    const idleStopAt = deps.runner?.idleStopAt(agent.id)
    const isolationNote = deps.isolationNote?.(agent, host?.engine ?? null)
    const vm = agent.vm
    return {
      agentId: agent.id,
      state,
      ...(stateMessage ? { stateMessage } : {}),
      host: { engine: host?.engine ?? null, provider: host?.provider ?? 'native', ...(host?.machine ? { machine: host.machine.name } : {}) },
      runtime: deps.runtime?.(agent) ?? {
        effective: null,
        status: vm.gvisor === 'force_off' || (vm.gvisor === 'inherit' && globalMode === 'force_off') ? 'forced_off' : 'not_installed',
        mode: vm.gvisor,
        globalMode,
      },
      internetPolicy: agent.internetPolicy,
      permissions: { browser: vm.permissions.browser, browserState: 'absent' },
      limits: VM_LIMITS,
      usage: {
        memoryMb: 0,
        personalBytes: workspace + inputs + memory,
        personalQuotaBytes: quotaBytes(),
        breakdown,
        snapshots: { bytes: 0, budgetBytes: (store.settings.vm?.snapshotBudget.perBotMb ?? 0) * 1024 * 1024, runsWithUndo: 0 },
      },
      env: vm.env,
      packages: vm.packages,
      ...(vm.tools ? { tools: vm.tools } : {}),
      image: vm.image,
      ...(idleStopAt && state === 'running' ? { idleStopAt } : {}),
      ...(isolationNote ? { isolationNote } : {}),
      storage: { backend: host?.storage.backend ?? 'local', driver: host?.storage.driver ?? null, location: root },
      runs: [],
      runsHasMore: false,
    }
  }

  const idOf = (request: { params: unknown }) => (request.params as { id: string }).id

  app.get('/api/agents/:id/vm', async (request) => vmInfo(agentOf(idOf(request))))

  app.patch('/api/agents/:id/vm', async (request) => {
    const agent = agentOf(idOf(request))
    const body = request.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Send a JSON object, e.g. {"env": []}.')
    const raw = body as Record<string, unknown>
    if ('egress' in raw) fail(400, EGRESS_NOT_AVAILABLE)
    if ('limits' in raw) fail(400, LIMITS_FIXED)
    const extra = Object.keys(raw).find((k) => !(VM_PATCH_KEYS as readonly string[]).includes(k))
    if (extra !== undefined) fail(400, `"${extra.slice(0, 40)}" can't be changed here.`)
    let internetPolicy: InternetPolicy = agent.internetPolicy
    let vm: AgentVm = { ...agent.vm }
    if (raw.internetPolicy !== undefined) {
      if (!INTERNET_POLICIES.includes(raw.internetPolicy as InternetPolicy)) fail(400, '"internetPolicy" must be "ask", "always" or "never".')
      internetPolicy = raw.internetPolicy as InternetPolicy
    }
    if (raw.permissions !== undefined) {
      const p = raw.permissions
      if (!p || typeof p !== 'object' || Array.isArray(p)) fail(400, '"permissions" must be an object, e.g. {"browser": false}.')
      const { browser, ...rest } = p as Record<string, unknown>
      if (Object.keys(rest).length) fail(400, `"permissions.${Object.keys(rest)[0]!.slice(0, 40)}" can't be changed here.`)
      if (browser !== undefined) {
        if (typeof browser !== 'boolean') fail(400, '"permissions.browser" must be true or false.')
        if (browser) fail(400, BROWSER_NOT_YET)
        vm = { ...vm, permissions: { browser } }
      }
    }
    if (raw.gvisor !== undefined) {
      if (!RUNTIME_MODES.includes(raw.gvisor as RuntimeMode)) fail(400, '"gvisor" must be "inherit", "force_on" or "force_off".')
      vm = { ...vm, gvisor: raw.gvisor as RuntimeMode }
    }
    if (raw.env !== undefined) {
      const problem = envListProblem(raw.env)
      if (problem) fail(400, problem)
      vm = { ...vm, env: (raw.env as EnvVar[]).map((e) => ({ name: e.name, value: e.value })) }
    }
    const next: Agent = { ...agent, internetPolicy, vm }
    const previous = store.agents
    store.agents = store.agents.map((a) => (a.id === agent.id ? next : a))
    if (!store.save()) {
      store.agents = previous
      fail(500, 'Couldn\'t save the change. Try again.')
    }
    return vmInfo(next)
  })

  app.post('/api/agents/:id/vm/start', async (request) => {
    const agent = agentOf(idOf(request))
    if (filesMissing(agent)) failWithReason(409, 'files_missing', 'The bot\'s files folder is missing, so its VM can\'t start.')
    await botEnv.start(agent)
    return vmInfo(agentOf(agent.id))
  })

  app.post('/api/agents/:id/vm/stop', async (request) => {
    const agent = agentOf(idOf(request))
    if (filesMissing(agent)) failWithReason(409, 'files_missing', 'The bot\'s files folder is missing.')
    deps.runner?.stopRuns(agent.id)
    await botEnv.stop(agent)
    return vmInfo(agent)
  })

  app.post('/api/agents/:id/vm/reset', async (request) => {
    const agent = agentOf(idOf(request))
    const body = request.body as { confirm?: unknown } | null | undefined
    if (!body || typeof body !== 'object' || body.confirm !== true) fail(400, 'Send {"confirm": true} to reset the bot\'s VM.')
    if (filesMissing(agent)) failWithReason(409, 'files_missing', 'The bot\'s files folder is missing.')
    deps.runner?.stopRuns(agent.id)
    await botEnv.reset(agent)
    return vmInfo(agentOf(agent.id))
  })

  app.get('/api/agents/:id/vm/tools', async (request): Promise<VmToolsInfo> => {
    const agent = agentOf(idOf(request))
    const vm = agent.vm
    return {
      agentId: agent.id,
      ...(vm.tools ? { tools: vm.tools } : {}),
      packages: vm.packages,
      image: vm.image,
      canRollback: vm.image.previous !== undefined && vm.image.previous < vm.image.generation,
    }
  })
}

/** Store-backed saveVm for the service: replace Agent.vm and save (rolls back on failure). */
export function storeSaveVm(store: WorkspaceStore) {
  return (agentId: string, vm: AgentVm): boolean => {
    const previous = store.agents
    store.agents = store.agents.map((a) => (a.id === agentId ? { ...a, vm } : a))
    if (store.save()) return true
    store.agents = previous
    return false
  }
}
