import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { BOT_QUOTA_BYTES } from './files.js'
import { createStore } from './store.js'
import { VM_LIMITS, type Agent } from './shared/types.js'
import { defaultAgentVm, DEFAULT_VM_SETTINGS, envNameProblem, normalizeAgentVm, normalizeVmSettings, vmSettingsView } from './vm-defaults.js'

/** BE-P2-1: Phase 2 types, defaults and the load-time migration. */

let dir = ''
beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'vm-defaults-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'agentcontrol-vm-defaults-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const t = '2026-10-01T00:00:00.000Z'
const phase1Agent = (id: string, slug: string, extra: object = {}) => ({
  id, name: slug, slug, description: '', instructions: '', modelId: 'm', endpointId: 'ep_local_llama', isPrimary: slug === 'primary', role: '',
  skillIds: [], status: 'idle', createdAt: t, lastRunAt: null, runCount: 0, internetPolicy: 'never', memoryLearn: false, ...extra,
})

describe('Phase 1 data loads with VM defaults', () => {
  it('gives every agent vm defaults (browser off) and settings.vm defaults, keeps Phase 1 fields, and persists once', () => {
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify({
      agents: [phase1Agent('agt_p', 'primary'), phase1Agent('agt_a', 'analyst')],
      settings: { autoRun: false, notify: true, telemetry: false },
    }))
    const store = createStore(path)
    expect(store.agents).toHaveLength(2)
    for (const a of store.agents) {
      expect(a.vm).toEqual({ permissions: { browser: false }, gvisor: 'inherit', env: [], packages: [], image: { generation: 0, base: 'base' }, egress: { allow: [] } })
      expect(a.internetPolicy).toBe('never')
      expect(a.memoryLearn).toBe(false)
    }
    expect(store.settings.autoRun).toBe(false)
    expect(store.settings.vm).toEqual({ ...DEFAULT_VM_SETTINGS, backups: { ...DEFAULT_VM_SETTINGS.backups } })
    expect(store.settings.vm!.snapshotBudget).toEqual({ perBotMb: 2048, globalMb: 15360, freeFloorMb: 5120 })
    expect(store.settings.vm!.gvisor).toBe('auto')
    // The migration was written back, and a second load is a no-op.
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { agents: Agent[] }
    expect(saved.agents.every((a) => a.vm?.permissions.browser === false)).toBe(true)
    const again = createStore(path)
    expect(again.agents.map((a) => a.vm)).toEqual(store.agents.map((a) => a.vm))
  })

  it('keeps valid stored vm fields and repairs malformed ones', () => {
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify({
      agents: [phase1Agent('agt_a', 'analyst', {
        vm: {
          permissions: { browser: true }, gvisor: 'force_off',
          env: [{ name: 'FOO', value: '1' }, { name: 'HTTP_PROXY', value: 'x' }, { name: 'AC_TOKEN', value: 'x' }, { name: 'FOO', value: 'dupe' }, { name: '9x', value: 'x' }],
          packages: ['ripgrep', 'ripgrep', 'bad pkg'], image: { generation: 3, previous: 2, builtAt: t, base: 'browser' },
          tools: { pip: ['pandas==2.2.3'], npm: [], optBin: ['duckdb'], updatedAt: t }, egress: { allow: ['192.168.1.0/24'] },
        },
      }), phase1Agent('agt_b', 'bad', { vm: 'nope' })],
    }))
    const store = createStore(path)
    const a = store.agents.find((x) => x.id === 'agt_a')!.vm
    expect(a.permissions.browser).toBe(true)
    expect(a.gvisor).toBe('force_off')
    expect(a.env).toEqual([{ name: 'FOO', value: '1' }])
    expect(a.packages).toEqual(['ripgrep'])
    expect(a.image).toEqual({ generation: 3, previous: 2, builtAt: t, base: 'browser' })
    expect(a.tools?.optBin).toEqual(['duckdb'])
    expect(a.egress).toEqual({ allow: [] })
    expect(store.agents.find((x) => x.id === 'agt_b')!.vm).toEqual(defaultAgentVm())
  })

  it('normalizes settings.vm within bounds and keeps server-only fields out of the view', () => {
    const { vm, changed } = normalizeVmSettings({
      gvisor: 'force_on', backups: { enabled: true, time: '25:00', keep: 99 },
      snapshotBudget: { perBotMb: 4096, globalMb: 10, freeFloorMb: 6000 }, volumeId: 'vol-1', machine: { diskGb: 90 },
    })
    expect(changed).toBe(true)
    expect(vm.gvisor).toBe('force_on')
    expect(vm.backups).toEqual({ enabled: true, time: '03:00', keep: 7 })
    expect(vm.snapshotBudget).toEqual({ perBotMb: 4096, globalMb: 15360, freeFloorMb: 6000 })
    expect(vm.volumeId).toBe('vol-1')
    expect(vm.machine).toEqual({ diskGb: 90 })
    expect(vmSettingsView(vm)).not.toHaveProperty('volumeId')
    expect(vmSettingsView(vm)).not.toHaveProperty('machine')
    expect(normalizeVmSettings(vm).changed).toBe(false)
    expect(normalizeAgentVm(defaultAgentVm()).changed).toBe(false)
  })

  it('rejects reserved and invalid env names with plain messages', () => {
    expect(envNameProblem('DATA_DIR')).toBeNull()
    expect(envNameProblem('PATH')).toMatch(/PATH_APPEND/)
    expect(envNameProblem('path')).toMatch(/reserved/)
    expect(envNameProblem('https_proxy')).toMatch(/reserved/)
    expect(envNameProblem('HOME')).toMatch(/reserved/)
    expect(envNameProblem('NO_PROXY')).toMatch(/reserved/)
    expect(envNameProblem('AC_RUN')).toMatch(/AC_/)
    expect(envNameProblem('1ABC')).toMatch(/valid variable name/)
    expect(envNameProblem('A-B')).toMatch(/valid variable name/)
  })

  it('keeps Phase 2 message kinds and deleted file changes, and drops cards without their id', () => {
    const path = join(dir, 'store.json')
    writeFileSync(path, JSON.stringify({
      agents: [phase1Agent('agt_a', 'analyst')],
      conversations: [{ id: 'conv-a', kind: 'dm', agentId: 'agt_a', createdAt: t, updatedAt: t, lastReadAt: null }],
      chatMessages: [
        { id: 'm1', conversationId: 'conv-a', role: 'assistant', content: '', createdAt: t, kind: 'run', scriptRunId: 'run_1', authorAgentId: 'agt_a',
          scriptRun: { status: 'succeeded', kind: 'script', name: 'clean.py', files: { added: 1, modified: 0, deleted: 2 }, undo: { state: 'available' } } },
        { id: 'm2', conversationId: 'conv-a', role: 'assistant', content: '', createdAt: t, kind: 'permission', permissionRequestId: 'perm_1', authorAgentId: 'agt_a' },
        { id: 'm3', conversationId: 'conv-a', role: 'assistant', content: 'x', createdAt: t, kind: 'run', authorAgentId: 'agt_a' },
        { id: 'm4', conversationId: 'conv-a', role: 'assistant', content: 'x', createdAt: t, authorAgentId: 'agt_a',
          activity: { skills: [], steps: [], filesChanged: [{ path: 'workspace/old.csv', change: 'deleted' }, { path: 'notes.md', change: 'added', root: 'group', groupId: 'grp_1', groupName: 'Ops', bogus: 1 }, { path: 'x.txt', change: 'modified', root: 'elsewhere', groupId: 'grp_2' }] } },
      ],
    }))
    const store = createStore(path)
    const byId = (id: string) => store.chatMessages.find((m) => m.id === id)!
    expect(byId('m1')).toMatchObject({ kind: 'run', scriptRunId: 'run_1', scriptRun: { name: 'clean.py', files: { deleted: 2 } } })
    expect(byId('m2')).toMatchObject({ kind: 'permission', permissionRequestId: 'perm_1' })
    expect(byId('m3').kind).toBeUndefined()
    expect(byId('m4').activity?.filesChanged).toEqual([
      { path: 'workspace/old.csv', change: 'deleted' },
      { path: 'notes.md', change: 'added', root: 'group', groupId: 'grp_1', groupName: 'Ops' },
      { path: 'x.txt', change: 'modified' },
    ])
  })
})

describe('routes after BE-P2-1', () => {
  it('creates bots with vm defaults, keeps vm on PUT, raises limits and leaves vm out of /api/settings', async () => {
    const store = createStore(join(dir, 'store.json'))
    const app = buildApp(store)
    try {
      const res = await app.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Analyst', endpointId: 'ep_local_llama', modelId: 'llama-3-8b' } })
      expect(res.statusCode).toBe(201)
      const bot = res.json() as Agent
      expect(bot.vm).toEqual(defaultAgentVm())
      store.agents.find((a) => a.id === bot.id)!.vm.env = [{ name: 'FOO', value: '1' }]
      const put = await app.inject({ method: 'PUT', url: `/api/agents/${bot.id}`, payload: { name: 'Analyst 2', description: '', modelId: 'llama-3-8b', endpointId: 'ep_local_llama', role: '', skillIds: [] } })
      expect(put.statusCode).toBe(200)
      expect((put.json() as Agent).vm.env).toEqual([{ name: 'FOO', value: '1' }])

      const settings = await app.inject({ method: 'GET', url: '/api/settings' })
      expect(settings.json()).toEqual({ autoRun: true, notify: true, telemetry: false })
      const patched = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { notify: false } })
      expect(patched.json()).toEqual({ autoRun: true, notify: false, telemetry: false })
      expect(store.settings.vm?.gvisor).toBe('auto')

      const sandbox = await app.inject({ method: 'GET', url: `/api/agents/${bot.id}/sandbox` })
      expect(sandbox.json().limits).toEqual({ cpus: 2, memoryMb: 4096, timeoutSec: 600, pids: 256, outputMb: 200, diskQuotaMb: 10240 })
      expect(BOT_QUOTA_BYTES).toBe(VM_LIMITS.personalDiskMb * 1024 * 1024)
    } finally {
      await app.close()
    }
  })
})
