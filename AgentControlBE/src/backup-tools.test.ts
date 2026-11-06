/**
 * BE-P2-18 follow-up: a restore rebuilds every tool type from the manifest (apt through Rebuild,
 * pip and npm through install runs, opt reported). Fake starters only: no engine, no storage.
 */
import { describe, expect, it } from 'vitest'
import type { BackupManifest } from './backup-service.js'
import { NPM_HOSTS, NPM_WHY, PIP_HOSTS, PIP_WHY, npmInstallArgv, pipInstallArgv, restoreTools } from './backup-tools.js'
import type { Agent, ScriptRun, ToolManifest } from './shared/types.js'

const bot = (vm: Partial<Agent['vm']> = {}): Agent =>
  ({
    id: 'agt_1',
    slug: 'analyst',
    name: 'Analyst',
    vm: { permissions: { browser: false }, gvisor: 'inherit', env: [], packages: [], image: { generation: 0, base: 'base' }, egress: { allow: [] }, ...vm },
  }) as unknown as Agent
const tools = (t: Partial<ToolManifest>): ToolManifest => ({ pip: [], npm: [], optBin: [], updatedAt: '2026-11-06T09:00:00.000Z', ...t })
const manifest = (packages: string[], t?: Partial<ToolManifest>): BackupManifest =>
  ({ version: 1, agentId: 'agt_1', slug: 'analyst', name: 'Analyst', createdAt: '2026-11-06T09:00:00.000Z', packages, ...(t ? { tools: tools(t) } : {}), image: { base: 'base', generation: 1 }, browser: false }) as BackupManifest

function harness(now: Agent, opts: { installStatus?: ScriptRun['status']; installError?: string; throwOn?: 'pip' | 'npm' | 'apt' } = {}) {
  const calls: { kind: string; argv?: string[]; why?: string; hosts?: string[] }[] = []
  let n = 0
  const run = (status: ScriptRun['status'] = 'queued', error?: string) => ({ id: `run_${++n}`, status, ...(error ? { error } : {}) }) as ScriptRun
  return {
    calls,
    deps: {
      current: () => now,
      startRebuild: async () => {
        calls.push({ kind: 'apt' })
        if (opts.throwOn === 'apt') throw new Error('Wait for the bot\'s run to finish first.')
        return run('running')
      },
      startInstall: async (_a: Agent, argv: string[], why: string, hosts: string[]) => {
        const kind = argv[0] === 'npm' ? 'npm' : 'pip'
        calls.push({ kind, argv, why, hosts })
        if (opts.throwOn === kind) throw new Error('Scripts are paused.')
        return run(opts.installStatus, opts.installError)
      },
    },
  }
}

describe('restoreTools', () => {
  it('nothing in the manifest: every type not_needed, nothing started', async () => {
    const h = harness(bot())
    const out = await restoreTools(bot(), manifest([]), h.deps)
    expect(out).toEqual({ tools: 'not_needed', toolResults: ['apt', 'pip', 'npm', 'opt'].map((kind) => ({ kind, status: 'not_needed', items: [] })) })
    expect(h.calls).toEqual([])
  })

  it('after a reset: apt rebuild, then pip and npm install runs with the pins; opt reported by name', async () => {
    const after = bot({ packages: ['jq'] })
    const h = harness(after)
    const m = manifest(['jq'], { pip: ['requests==2.32.3', 'Pillow[webp]==11.0.0'], npm: ['cowsay@1.6.0', '@scope/tool@2.0.1'], optBin: ['mytool'] })
    const out = await restoreTools(bot(), m, h.deps)
    expect(h.calls).toEqual([
      { kind: 'apt' },
      { kind: 'pip', argv: pipInstallArgv(['requests==2.32.3', 'Pillow[webp]==11.0.0']), why: PIP_WHY, hosts: PIP_HOSTS },
      { kind: 'npm', argv: npmInstallArgv(['cowsay@1.6.0', '@scope/tool@2.0.1']), why: NPM_WHY, hosts: NPM_HOSTS },
    ])
    expect(pipInstallArgv(['a==1'])).toEqual(['python3', '-m', 'pip', 'install', '--user', '--disable-pip-version-check', '--no-input', 'a==1'])
    expect(npmInstallArgv(['a@1'])).toEqual(['npm', 'install', '-g', '--no-fund', '--no-audit', 'a@1'])
    expect(out.tools).toBe('started')
    expect(out.toolResults).toEqual([
      { kind: 'apt', status: 'started', items: ['jq'], runId: 'run_1' },
      { kind: 'pip', status: 'started', items: ['requests==2.32.3', 'Pillow[webp]==11.0.0'], runId: 'run_2' },
      { kind: 'npm', status: 'started', items: ['cowsay@1.6.0', '@scope/tool@2.0.1'], runId: 'run_3' },
      { kind: 'opt', status: 'not_restorable', items: ['mytool'], message: "These programs in /opt/bot/bin can't be reinstalled from a backup: mytool. Ask the bot to set them up again." },
    ])
    expect(out.toolsMessage).toBe("These programs in /opt/bot/bin can't be reinstalled from a backup: mytool. Ask the bot to set them up again.")
  })

  it('tools the bot still has (its volumes are there) are not_needed; only the missing pins are installed', async () => {
    const now = bot({ packages: ['jq'], image: { generation: 2, base: 'base' }, tools: tools({ pip: ['Requests==2.32.3'], npm: ['cowsay@1.6.0'], optBin: ['mytool'] }) })
    const h = harness(now)
    const out = await restoreTools(now, manifest(['jq'], { pip: ['requests==2.32.3', 'numpy==2.1.0'], npm: ['cowsay@1.6.0'], optBin: ['mytool'] }), h.deps)
    expect(h.calls).toEqual([{ kind: 'pip', argv: pipInstallArgv(['numpy==2.1.0']), why: PIP_WHY, hosts: PIP_HOSTS }])
    expect(out.toolResults.map((r) => [r.kind, r.status])).toEqual([['apt', 'not_needed'], ['pip', 'started'], ['npm', 'not_needed'], ['opt', 'not_needed']])
    expect(out.tools).toBe('started')
  })

  it('unsafe or odd entries are never put on a command line; they are named in the message', async () => {
    const h = harness(bot())
    const out = await restoreTools(bot(), manifest([], { pip: ['-e git+https://x/y.git#egg=y', 'pkg @ file:///tmp/p.whl', 'ok==1.0'], npm: ['--registry=http://evil', 'x@1; rm -rf /'] }), h.deps)
    expect(h.calls).toEqual([{ kind: 'pip', argv: pipInstallArgv(['ok==1.0']), why: PIP_WHY, hosts: PIP_HOSTS }])
    const [, pip, npm] = out.toolResults
    expect(pip).toMatchObject({ status: 'started', message: 'Not reinstalled (not a plain name and version): -e git+https://x/y.git#egg=y, pkg @ file:///tmp/p.whl.' })
    expect(npm).toMatchObject({ status: 'failed', message: 'Not reinstalled (not a plain name and version): --registry=http://evil, x@1; rm -rf /.' })
    expect(out.tools).toBe('failed')
  })

  it('an install refused at once (internet Never: denied) or throwing is failed with its reason; the others still go', async () => {
    const never = "Internet is set to Never for Analyst, so this run didn't start. Change it in Settings › VM."
    const h = harness(bot(), { installStatus: 'denied', installError: never })
    const out = await restoreTools(bot(), manifest([], { pip: ['a==1'], npm: ['b@2'] }), h.deps)
    expect(out.toolResults[1]).toEqual({ kind: 'pip', status: 'failed', items: ['a==1'], runId: 'run_1', message: never })
    expect(out.toolResults[2]).toMatchObject({ kind: 'npm', status: 'failed', runId: 'run_2' })
    expect(out.toolsMessage).toBe(`${never} ${never}`)
    const t = harness(bot({ packages: ['jq'] }), { throwOn: 'apt' })
    const out2 = await restoreTools(bot(), manifest(['jq'], { npm: ['b@2'] }), t.deps)
    expect(out2.toolResults[0]).toMatchObject({ kind: 'apt', status: 'failed', message: "Wait for the bot's run to finish first." })
    expect(out2.toolResults[2]).toMatchObject({ kind: 'npm', status: 'started' })
    expect(out2.tools).toBe('failed')
  })

  it('the package list could not be saved: apt failed, nothing built', async () => {
    const h = harness(bot({ packages: [] }))
    const out = await restoreTools(bot(), manifest(['jq']), h.deps)
    expect(out.toolResults[0]).toEqual({ kind: 'apt', status: 'failed', items: ['jq'], message: "Couldn't save the bot's package list from the backup." })
    expect(h.calls).toEqual([])
  })
})
