// FE-P2-10: VM tab M2 (mockups m2-11…14, contract fec4670): low-disk text, browser row, tool build head/env/history, routes, live store.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BLOCKED_RANGES, BUILD_WAIT_TEXT,
  andList, browserConfirm, browserRow, buildHead, buildingTools, buildingToolsText, elapsedText, etaText, filesSplitText,
  historyRow, internetRowText, internetSub, isBuildActive, vmActionError, vmHeader, vmTabModel,
} from '../src/lib/vm-tab.ts'
import { renderVmTab } from '../src/lib/vm-tab-render.ts'
import { createVmApi } from '../src/lib/vm-api.ts'
import { initialLiveState, liveReducer, runSummaryRow, runInternetUse } from '../src/lib/live-store.ts'
import { macHost, probeResult, runRow, vmInfo } from './vm-fixtures.mjs'
import { NOW, addon, browserStates, buildRuns, buildingVm } from './vm-m2-fixtures.mjs'

const ui = (extra = {}) => ({ busy: null, errors: {}, editor: null, hasMore: false, ...extra })
const model = (vm, extra = {}) => vmTabModel({ vm, botName: 'Primary', host: macHost(), probe: probeResult(), groupNames: {}, now: NOW, ...extra })
const html = (m, u = ui()) => renderToStaticMarkup(renderVmTab(m, u))
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
const row = (key) => {
  const { vm, addon: a } = browserStates[key]()
  return browserRow({ vm, botName: 'Primary', addon: a, now: NOW })
}

// The low-disk cases (constants, sentences, browserLowDiskText) moved to tests/low-disk.test.mjs with the code.

describe('permissions card (mockup 11)', () => {
  it('internet line per policy', () => {
    assert.equal(internetSub('ask', 'Primary'), 'Primary shows a card in the chat when a script needs it. No answer in 10 minutes counts as Deny.')
    assert.equal(internetSub('always', 'Primary'), 'Scripts get the internet without asking. Every site used is listed on the run.')
    assert.equal(internetSub('never', 'Primary'), 'Scripts that need the internet are denied without asking.')
  })
  it('renders the live switch, the policy line and the blocked list', () => {
    const out = html(model(vmInfo({ internetPolicy: 'always' })))
    assert.match(out, /role="switch" aria-checked="false" aria-label="Browser \(Playwright\)"\/?>/)
    assert.match(text(out), /Scripts get the internet without asking\./)
    assert.equal(BLOCKED_RANGES.length, 7)
    for (const r of BLOCKED_RANGES) assert.ok(out.includes(`<li>${r}</li>`), r)
    assert.match(out, /<ul class="vm-blocked"/)
  })
})

describe('browser row (mockup 12 + GAPs)', () => {
  it('off', () => {
    const r = row('off')
    assert.equal(r.text, "Off. Primary asks in chat when a script needs a browser. Turning it on downloads headless Chromium once (about 1.3 GB, shared by all bots, not counted in Primary's 10 GB). Web pages still follow the Internet rule.")
    assert.deepEqual([r.on, r.locked, r.actions], [false, false, []])
  })
  it('downloading: percent, bytes of total, eta, then-rebuild', () => {
    const r = row('downloading')
    assert.equal(r.text, 'On. Downloading headless Chromium (46%)…')
    assert.deepEqual(r.progress, { pct: 46, text: "620 MB of 1.3 GB · about 1 min left · then Primary's tools are rebuilt and its VM restarts when idle" })
    assert.equal(r.locked, true)
  })
  it('setting up before any progress (GAP-V20)', () => {
    const r = row('setting_up')
    assert.equal(r.text, 'On. Getting headless Chromium ready…')
    assert.equal(r.progress.pct, null)
    assert.equal(r.gap, 'V20')
  })
  it('rebuilding: step 2 of 3 with the build elapsed', () => {
    const r = row('rebuilding')
    assert.equal(r.text, "On. Rebuilding Primary's tools on the browser base…")
    assert.deepEqual(r.progress, { pct: 70, text: 'Step 2 of 3 · rebuild 0:38 · next: restart when idle and check Chromium' })
  })
  it('waiting for idle', () => {
    assert.equal(row('waiting_idle').text, "On. Ready; Primary's VM restarts after the current run finishes.")
    assert.equal(row('waiting_idle').locked, true)
  })
  it('ready', () => {
    const r = row('ready')
    assert.equal(r.text, 'On. Web pages still follow the Internet rule.')
    assert.equal(r.sub, 'Chromium 131 · checked today 9:54 AM · download shared by 2 bots (1.3 GB)')
    const one = browserRow({ ...browserStates.ready(), botName: 'Primary', addon: addon({ state: 'ready', usedBy: ['primary'] }), now: NOW })
    assert.match(one.sub, /shared by 1 bot \(1\.3 GB\)$/)
    assert.equal(browserRow({ vm: browserStates.ready().vm, botName: 'Primary', now: NOW }).sub, 'Chromium 131 · checked today 9:54 AM')
  })
  it('download failed: detail in the line, Try again / Turn off, stamped error', () => {
    const r = row('download_failed')
    assert.equal(r.text, "On, but headless Chromium couldn't be downloaded: the connection dropped at 840 MB.")
    assert.deepEqual(r.actions, ['retry', 'turn_off'])
    assert.equal(r.error, 'Download failed · today 9:53 AM')
  })
  it('chromium check failed: Re-check / Turn off', () => {
    const r = row('check_failed')
    assert.equal(r.text, "On, but Chromium didn't start in Primary's VM, so Primary kept its previous tools.")
    assert.deepEqual(r.actions, ['recheck', 'turn_off'])
    assert.equal(r.error, 'Chromium check failed: libnss3.so missing')
  })
  it('low disk (GAP-V15) and build failed (GAP-V16) use the server message', () => {
    const l = row('low_disk')
    assert.equal(l.error, 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 2.5 GB free.')
    assert.equal(l.gap, 'V15')
    const b = row('build_failed')
    assert.equal(b.error, 'Stopped. Analyst keeps its current tools (version 3).')
    assert.equal(b.gap, 'V16')
  })
  it('turning off (GAP-V17) and the unused download', () => {
    assert.equal(row('turning_off').text, "Off. Rebuilding Primary's tools without the browser…")
    assert.equal(row('turning_off').locked, true)
    const r = row('off_remove')
    assert.equal(r.text, 'Off. Primary asks in chat when a script needs a browser.')
    assert.equal(r.sub, 'The Chromium download (1.3 GB) is still on this computer and no bot uses it.')
    assert.deepEqual(r.actions, ['remove'])
  })
  it('renders progress, actions and the error', () => {
    const { vm, addon: a } = browserStates.download_failed()
    const out = html(model(vm, { browserAddon: a }))
    assert.match(out, /<div class="vm-acts"><button type="button" class="btn">Try again<\/button><button type="button" class="btn btn--ghost">Turn off<\/button><\/div>/)
    assert.match(out, /<p class="vm-err" role="alert">Download failed · today 9:53 AM<\/p>/)
    const dl = browserStates.downloading()
    const out2 = html(model(dl.vm, { browserAddon: dl.addon }))
    assert.match(out2, /class="vm-prog__bar"[^>]*aria-valuenow="46"><span style="width:46%">/)
    assert.match(out2, /role="switch" aria-checked="true" aria-label="Browser \(Playwright\)" disabled=""/)
    assert.match(html(model(dl.vm, { browserAddon: dl.addon }), ui({ busy: 'retry' })), /disabled=""/)
  })
  it('confirm dialog copy (mockup 13)', () => {
    const c = browserConfirm('Primary', 'ask')
    assert.equal(c.title, 'Turn on the browser for Primary?')
    assert.equal(c.lead, "Primary's scripts will be able to use headless Chromium (Playwright).")
    assert.deepEqual(c.items, [
      "Downloads Chromium once: about 1.3 GB, shared by all bots, not counted in Primary's 10 GB.",
      "Rebuilds Primary's tools and restarts its VM when it's idle (a few minutes).",
      "Web pages still follow Primary's Internet rule: ",
    ])
    assert.equal(c.rule, 'Ask each time')
    assert.equal(browserConfirm('Primary', 'always').rule, 'Always allow')
    assert.equal(c.confirm, 'Turn on browser')
  })
})

describe('tool build (mockup 14 + GAP-V13/V14)', () => {
  it('helpers', () => {
    assert.equal(andList(['a']), 'a')
    assert.equal(andList(['a', 'b']), 'a and b')
    assert.equal(andList(['a', 'b', 'c']), 'a, b and c')
    assert.equal(elapsedText(new Date(NOW.getTime() - 72000).toISOString(), NOW), '1:12')
    assert.equal(elapsedText(new Date(NOW.getTime() - 3725000).toISOString(), NOW), '1:02:05')
    assert.equal(elapsedText(undefined, NOW), null)
    assert.equal(etaText(64), 'about 1 min left')
    assert.equal(etaText(undefined), null)
  })
  it('head: Building tools, Stop and Reset disabled, sub + progress + stop note', () => {
    const vm = buildingVm()
    const hd = vmHeader(vm, 'Primary', 'mac', NOW)
    assert.deepEqual([hd.badge, hd.tone, hd.spinner, hd.busy, hd.stop, hd.reset], ['Building tools', 'run', true, true, true, true])
    const b = buildHead(vm.activeBuild, 'Primary', NOW)
    assert.equal(b.text, 'Adding matplotlib and pandas (version 3) · 1:12. New runs wait for the build, then use the new tools.')
    assert.deepEqual(b.progress, { pct: 67, text: 'Step 4 of 6 · pip install · internet allowed once for this build' })
    assert.equal(b.stopNote, 'Stopping keeps the current tools (version 2).')
    assert.equal(b.runId, 'build-3')
  })
  it('queued and waiting-permission heads (GAP-V14)', () => {
    const q = buildHead(buildingVm('queued').activeBuild, 'Primary', NOW)
    assert.equal(q.gap, 'V14')
    assert.equal(q.progress.pct, null)
    assert.match(q.text, /^Adding matplotlib and pandas \(version 3\) · waits for Primary's current run to finish\./)
    assert.match(buildHead(buildingVm('waiting_permission').activeBuild, 'Primary', NOW).text, /waiting for your OK in the chat/)
  })
  it('renders Stop build (enabled / stopping / disabled while busy) and the head error', () => {
    const m = model(buildingVm())
    const out = html(m)
    assert.match(out, /<button type="button" class="btn">Stop build<\/button><button type="button" class="btn" disabled="">Stop<\/button><button type="button" class="btn btn--ghost" disabled="">Reset VM…<\/button>/)
    assert.match(text(out), /Stopping keeps the current tools \(version 2\)\./)
    assert.match(html(m, ui({ busy: 'stopbuild' })), /disabled="">Stopping build…</)
    assert.match(html(m, ui({ errors: { head: "Couldn't stop the build. Try again." } })), /role="alert">Couldn&#x27;t stop the build/)
    assert.doesNotMatch(html(model(vmInfo())), /Stop build/)
  })
  it('env card: version line, Build log, disabled Rebuild / Go back with the note', () => {
    const m = model(buildingVm())
    assert.equal(buildingToolsText(m.buildingTools), 'building version 3: + matplotlib, pandas')
    assert.deepEqual(buildingTools({ generation: 2, fromGeneration: 1, added: [], removed: ['x'] }).removed, ['x'])
    const out = html(m)
    assert.match(out, /Version 2: system: <code>jq<\/code> · building version 3: \+ <code>matplotlib<\/code>, <code>pandas<\/code>/)
    assert.match(out, />Build log</)
    assert.match(out, /<button type="button" class="btn" disabled="">Rebuild tools<\/button><button type="button" class="btn btn--ghost" disabled="">Go back to version 1<\/button><span class="vm-sub vm-inline">Available when the build finishes\.<\/span>/)
    assert.equal(m.runActive, true)
  })
  it('history rows', () => {
    const [q, b, ok] = buildRuns().map((r) => historyRow(r, { now: NOW }))
    assert.deepEqual([q.icon, q.iconTone, q.name, q.meta, q.action], ['◌', 'run', 'chart_revenue.py', 'Queued · after tool build · DM', 'none'])
    assert.deepEqual([b.icon, b.name, b.meta, b.action], ['⚙', 'Tool build · version 3', 'Running 1:12 · internet once · pypi.org, files.pythonhosted.org', 'output'])
    assert.equal(ok.meta, '1 file added · 3.8 s · internet once · DM')
    assert.equal(ok.action, 'undo')
  })
  it('ended tool build and the files split', () => {
    const r = historyRow(runRow('b', { kind: 'tool_build', status: 'succeeded', network: 'on', internet: 'always', hosts: ['pypi.org'], durationMs: 61000, filesChangedCount: 0, undo: { state: 'none' }, build: { generation: 4 } }), { now: NOW })
    assert.equal(r.name, 'Tool build · version 4')
    assert.doesNotMatch(r.meta, /files/)
    assert.match(r.meta, /internet always · pypi\.org$/)
    assert.equal(filesSplitText({ filesChangedCount: 3, files: { added: 1, modified: 2, deleted: 0 } }), '1 file added, 2 modified')
    assert.equal(filesSplitText({ filesChangedCount: 2, files: { added: 0, modified: 0, deleted: 2 } }), '2 files deleted')
    assert.equal(filesSplitText({ filesChangedCount: 4, files: { added: 1, modified: 0, deleted: 0 } }), '4 files changed')
    assert.equal(internetRowText({ network: 'off' }), null)
    assert.equal(internetRowText({ network: 'on' }), 'internet once')
  })
  it('build_active 409 shows the mockup copy (GAP-V22)', () => {
    const e = Object.assign(new Error("Primary's tools are already building."), { status: 409, body: { reason: 'build_active' } })
    assert.equal(isBuildActive(e), true)
    assert.equal(vmActionError(e, 'x'), BUILD_WAIT_TEXT)
    assert.equal(vmActionError(Object.assign(new Error('Not enough disk.'), { status: 409, body: { reason: 'low_disk' } }), 'x'), 'Not enough disk.')
  })
})

describe('vm api: browser routes (BE-P2-15) and the 202 rebuild', () => {
  const recorder = () => {
    const calls = []
    const request = async (path, init = {}) => {
      calls.push([init.method ?? 'GET', path, init.body ? JSON.parse(init.body) : undefined, init.headers])
      return {}
    }
    return { api: createVmApi(request, request), calls }
  }
  it('paths, bodies and the confirm header', async () => {
    const { api, calls } = recorder()
    await api.getBrowser()
    await api.retryBrowser()
    await api.retryBrowser('primary')
    await api.removeBrowser()
    await api.stopRun('build-3')
    assert.deepEqual(calls.map((c) => c.slice(0, 3)), [
      ['GET', '/api/vm/browser', undefined],
      ['POST', '/api/vm/browser/retry', {}],
      ['POST', '/api/vm/browser/retry', { agentId: 'primary' }],
      ['DELETE', '/api/vm/browser', undefined],
      ['POST', '/api/runs/build-3/stop', undefined],
    ])
    assert.equal(calls[3][3]['x-agentcontrol-confirm'], '1')
  })
})

describe('live store (M2)', () => {
  it('browser action and browser.updated event', () => {
    const b = addon({ state: 'downloading', progress: 0.2 })
    let s = liveReducer(initialLiveState, { type: 'browser', browser: b })
    assert.deepEqual(s.browser, b)
    const b2 = addon({ state: 'ready', usedBy: ['primary'] })
    s = liveReducer(s, { type: 'event', event: { type: 'browser.updated', browser: b2 } })
    assert.deepEqual(s.browser, b2)
  })
  it('history row from a run: network, internet, reached hosts (3), build, queued reason kept', () => {
    const run = {
      ...runRow('r1', { status: 'queued' }), context: 'dm', network: 'on', browser: false, outputTruncated: false, filesChanged: [],
      permissions: [{ type: 'internet', decision: 'always' }],
      hostsContacted: [{ host: 'a.com' }, { host: '10.0.0.1', blocked: 'private' }, { host: 'b.com' }, { host: 'c.com' }, { host: 'd.com' }],
      build: { generation: 3 },
    }
    const r = runSummaryRow(run, { ...runRow('r1'), queuedReason: 'tool_build' })
    assert.equal(r.network, 'on')
    assert.equal(r.internet, 'always')
    assert.deepEqual(r.hosts, ['a.com', 'b.com', 'c.com'])
    assert.deepEqual(r.build, { generation: 3 })
    assert.equal(r.queuedReason, 'tool_build')
    assert.equal(runSummaryRow({ ...run, status: 'running' }, { queuedReason: 'tool_build' }).queuedReason, undefined)
    assert.equal(runInternetUse({ network: 'on', permissions: [] }), 'once')
    assert.equal(runInternetUse({ network: 'off' }), 'off')
  })
})

describe('VmTab.tsx wiring (M2)', () => {
  it('uses the contract routes', () => {
    const src = readFileSync(new URL('../src/components/settings/VmTab.tsx', import.meta.url), 'utf8')
    for (const s of ['api.vm.stopRun(build.runId)', 'api.vm.getBrowser()', 'api.vm.retryBrowser(agent.id)', 'api.vm.removeBrowser()', '{ permissions: { browser: on } }', "'run' in res ? res.run : res", 'browserConfirm('])
      assert.ok(src.includes(s), s)
  })
})
