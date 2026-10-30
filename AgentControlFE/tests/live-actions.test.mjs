import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { liveActions } from '../src/state/live-actions.ts'

function fakeController() {
  const sent = []
  const loadRun = async () => undefined, loadVm = async () => undefined, trackRuns = () => undefined, loadPermission = async () => undefined
  const vmReply = async () => undefined
  return { sent, loadRun, loadVm, trackRuns, loadPermission, vmReply, dispatch: (a) => sent.push(a) }
}

describe('liveActions (BE-15 check: VmTab GET /api/vm/browser loop)', () => {
  it('each put* dispatches its store action; loads are the controller\'s own functions', () => {
    const c = fakeController()
    const a = liveActions(c)
    const browser = { state: 'ready', totalBytes: 1343000000, usedBy: [] }
    a.putBrowser(browser)
    a.putVm({ agentId: 'agt_1' })
    a.putRun({ id: 'run_1' })
    a.putPermission({ id: 'perm_1' })
    assert.deepEqual(c.sent, [
      { type: 'browser', browser },
      { type: 'vm', vm: { agentId: 'agt_1' } },
      { type: 'run', run: { id: 'run_1' } },
      { type: 'permissions', requests: [{ id: 'perm_1' }] },
    ])
    assert.equal(a.loadRun, c.loadRun)
    assert.equal(a.loadVm, c.loadVm)
    assert.equal(a.trackRuns, c.trackRuns)
    assert.equal(a.loadPermission, c.loadPermission)
    assert.equal(a.vmReply, c.vmReply)
    assert.equal('state' in a, false)
  })

  it('LiveProvider builds the actions once per controller, not per state (else putBrowser changes on every dispatch and VmTab refetches without end)', () => {
    const src = readFileSync(new URL('../src/state/LiveProvider.tsx', import.meta.url), 'utf8')
    assert.match(src, /useMemo\(\(\) => liveActions\(controller\), \[controller\]\)/)
    assert.match(src, /useMemo<LiveContextValue>\(\(\) => \(\{ state, \.\.\.actions \}\), \[state, actions\]\)/)
    assert.doesNotMatch(src, /put\w+: \(/, 'no inline put* closures in the provider')
  })

  it('VmTab re-reads the shared download only when putBrowser or the SSE reset count changes', () => {
    const src = readFileSync(new URL('../src/components/settings/VmTab.tsx', import.meta.url), 'utf8')
    assert.match(src, /api\.vm\.getBrowser\(\)\.then\(\(b\) => live && putBrowser\(b\), \(\) => undefined\)\s*return \(\) => \{\s*live = false\s*\}\s*\}, \[putBrowser, state\.resets\]\)/)
  })
})
