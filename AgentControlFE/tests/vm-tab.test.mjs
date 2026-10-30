// FE-P2-5: VM tab view model (src/lib/vm-tab.ts) and markup (src/lib/vm-tab-render.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  vmHistory,
  RESET_ACTIVE_TEXT, RESET_TEXT, RESET_TITLE, VM_TAB_GAPS, breakdownText, envNameProblem, envRowErrors, envWith, filesLive, historyRow, historyTime,
  isolationView, packageLabel, toolsLine, vmActionError, vmHeader, vmMeters, vmNotices, vmPlatform, vmSubtitle, vmTabDot, vmTabModel,
} from '../src/lib/vm-tab.ts'
import { renderVmTab } from '../src/lib/vm-tab-render.ts'
import { vmPaths } from '../src/lib/vm-api.ts'
import { NOW, macHost, mockRuns, probeResult, runRow, vmInfo, winHost, winVm } from './vm-fixtures.mjs'

const GB = 1024 ** 3
const ui = (extra = {}) => ({ busy: null, errors: {}, editor: null, hasMore: false, exportHref: '/api/agents/analyst/export', ...extra })
const model = (vm = vmInfo(), extra = {}) => vmTabModel({ vm, botName: 'Analyst', host: macHost(), probe: probeResult(), groupNames: { 'g-q3': 'Q3 report' }, now: NOW, ...extra })
const html = (m = model(), u = ui()) => renderToStaticMarkup(renderVmTab(m, u))
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('vm tab: header (mockup c + GAP-V1)', () => {
  it('running on a Mac: badge, title, subtitle with idle stop, Stop + Reset', () => {
    const h = vmHeader(vmInfo(), 'Analyst', 'mac', NOW)
    assert.equal(h.badge, 'Running')
    assert.equal(h.title, "Analyst's VM")
    assert.equal(h.subtitle, "Analyst's own container · Podman on this Mac (libkrun) · idle stop in 12 min")
    assert.deepEqual([h.start, h.stop, h.reset], [null, true, true])
  })
  it('each state has its own badge and copy', () => {
    const seen = new Map()
    for (const state of ['not_setup', 'stopped', 'starting', 'running', 'error', 'files_missing']) {
      const h = vmHeader(vmInfo({ state }), 'Analyst', 'mac', NOW)
      seen.set(state, `${h.badge}|${h.message}|${h.banner}`)
    }
    assert.equal(new Set(seen.values()).size, 6)
    const ns = vmHeader(vmInfo({ state: 'not_setup' }), 'Analyst', 'mac', NOW)
    assert.equal(ns.start, 'Set up now')
    assert.equal(ns.reset, false)
    assert.equal(vmHeader(vmInfo({ state: 'starting' }), 'Analyst', 'mac', NOW).busy, true)
    assert.equal(vmHeader(vmInfo({ state: 'error', stateMessage: 'Podman machine is stopped.' }), 'Analyst', 'mac', NOW).message, 'Podman machine is stopped.')
    const fm = vmHeader(vmInfo({ state: 'files_missing' }), 'Analyst', 'mac', NOW)
    assert.equal(fm.start, null, 'GAP-V11: no Start empty route')
    assert.match(fm.message, /later update/, 'M1: Restore hidden')
  })
  it('subtitle without an engine, and on Windows', () => {
    assert.match(vmSubtitle(vmInfo({ host: { engine: null, provider: '' }, state: 'not_setup' }), 'Analyst', 'mac', NOW), /no container engine found yet/)
    assert.match(vmSubtitle(winVm(), 'Analyst', 'windows', NOW), /Podman on this PC \(WSL\)/)
  })
  it('platform: host os wins, else backend/provider', () => {
    assert.equal(vmPlatform(vmInfo(), { os: 'win32' }), 'windows')
    assert.equal(vmPlatform(vmInfo(), null), 'mac')
    assert.equal(vmPlatform(winVm(), null), 'windows')
    assert.equal(vmPlatform(vmInfo({ host: { engine: 'podman', provider: 'native' } }), null), 'linux')
  })
})

describe('vm tab: meters', () => {
  it('memory, bot files & tools (with breakdown), undo snapshots, per run', () => {
    const m = vmMeters(vmInfo())
    assert.deepEqual(m.map((x) => x.label), ['Memory', 'Bot files & tools', 'Undo snapshots', 'Per run'])
    assert.equal(m[0].value, '1.2 GB')
    assert.equal(m[0].of, 'of 4 GB')
    assert.equal(m[1].value, '1.9 GB')
    assert.equal(m[1].note, 'workspace 0.4 · tools and packages 1.5')
    assert.equal(m[2].note, 'separate budget · 14 runs')
    assert.equal(m[3].value, '2 CPUs')
    assert.equal(m[3].pct, null)
  })
  it('over quota is bad; 80%+ warns', () => {
    const over = vmMeters(vmInfo({ usage: { ...vmInfo().usage, personalBytes: 11 * GB } }))
    assert.equal(over[1].tone, 'bad')
    const warn = vmMeters(vmInfo({ usage: { ...vmInfo().usage, personalBytes: 8.5 * GB } }))
    assert.equal(warn[1].tone, 'warn')
    assert.equal(breakdownText({ workspace: 0, inputs: 0, memory: 0, tools: 0, opt: 0, imageLayer: 0 }), 'workspace 0 · tools and packages 0')
    assert.equal(breakdownText({ workspace: 0, inputs: 0, memory: 0, tools: 0, opt: 0, imageLayer: 2 * GB }), 'workspace 0 · tools and packages 2', 'imageLayer (vm_install) counts as packages')
    assert.doesNotMatch(breakdownText(vmInfo().usage.breakdown), /env/, 'env vars are not counted')
  })
})

describe('vm tab: isolation (GAP-V4) — each runtime status renders its own copy', () => {
  const statuses = ['active', 'not_installed', 'incompatible_fallback', 'forced_off', 'required_unavailable']
  it('one badge and one line per status', () => {
    const views = statuses.map((status) => isolationView(vmInfo({ runtime: { ...vmInfo().runtime, status } }), 'Analyst', { now: NOW }))
    assert.equal(new Set(views.map((v) => v.badge)).size, statuses.length)
    assert.equal(new Set(views.map((v) => v.text)).size, statuses.length)
    assert.deepEqual(views.map((v) => v.tone), ['on', 'off', 'warn', 'off', 'bad'])
  })
  it('active (forced), reasons and checked time', () => {
    const forced = isolationView(vmInfo({ runtime: { ...vmInfo().runtime, mode: 'force_on' } }), 'Analyst', { now: NOW })
    assert.equal(forced.badge, 'gVisor · Active (forced)')
    assert.equal(forced.checked, 'Checked today 5:02 PM.')
    const inc = isolationView(vmInfo({ runtime: { ...vmInfo().runtime, status: 'incompatible_fallback', reason: 'bind-mount ownership check failed' } }), 'Analyst', { now: NOW })
    assert.match(inc.text, /\(bind-mount ownership check failed\)/)
    const probeOnly = isolationView(vmInfo({ runtime: { ...vmInfo().runtime, status: 'required_unavailable', checkedAt: undefined } }), 'Analyst', {
      now: NOW,
      probe: probeResult({ compatible: false, checks: [{ id: 'network', status: 'fail', message: 'network check failed' }] }),
    })
    assert.match(probeOnly.text, /network check failed/)
    assert.match(probeOnly.checked, /Checked today/)
  })
  it('M1: no Settings › VMs link in the hint', () => {
    for (const status of statuses) assert.doesNotMatch(isolationView(vmInfo({ runtime: { ...vmInfo().runtime, status } }), 'Analyst').hint, /Settings ›/)
  })
})

describe('vm tab: environment (GAP-V6) — reserved names show an inline error', () => {
  it('names mirror the BE envNameProblem wording', () => {
    assert.equal(envNameProblem('PATH'), '"PATH" is reserved. Use PATH_APPEND to add folders to it.')
    assert.equal(envNameProblem('HOME'), '"HOME" is reserved and set by AgentControl.')
    assert.equal(envNameProblem('AC_TOKEN'), 'Names starting with AC_ are reserved for AgentControl.')
    assert.equal(envNameProblem('1X'), '"1X" isn\'t a valid variable name. Use letters, digits and _, starting with a letter or _.')
    assert.equal(envNameProblem('MY_VAR'), null)
  })
  it('row errors: empty, duplicate, too long', () => {
    const list = vmInfo().env
    assert.equal(envRowErrors(list, -1, '', 'x').name, 'Enter a name.')
    assert.equal(envRowErrors(list, -1, 'TZ', 'x').name, '"TZ" is already set.')
    assert.equal(envRowErrors(list, 0, 'TZ', 'UTC').name, null, 'editing itself is fine')
    assert.match(envRowErrors(list, -1, 'X', 'v'.repeat(5000)).value, /4,096 characters/)
  })
  it('envWith adds, replaces and removes', () => {
    const list = [{ name: 'A', value: '1' }]
    assert.deepEqual(envWith(list, -1, { name: ' B ', value: '2' }), [{ name: 'A', value: '1' }, { name: 'B', value: '2' }])
    assert.deepEqual(envWith(list, 0, { name: 'A', value: '9' }), [{ name: 'A', value: '9' }])
    assert.deepEqual(envWith(list, 0, null), [])
  })
  it('the inline editor renders the error under the name field', () => {
    const out = html(model(), ui({ editor: { index: -1, name: 'PATH', value: '/x', errors: { name: envNameProblem('PATH'), value: null } } }))
    assert.match(out, /aria-invalid="true"/)
    assert.match(out, /class="input vm-mono input--invalid"/)
    assert.match(text(out), /"PATH" is reserved\. Use PATH_APPEND to add folders to it\./)
    assert.match(out, /role="alert"/)
    assert.doesNotMatch(out, />Add variable</, 'no second add while adding')
  })
  it('tools line and package labels', () => {
    assert.equal(packageLabel('pandas==2.2.3'), 'pandas 2.2.3')
    const t = toolsLine(vmInfo(), 'Analyst', NOW)
    assert.equal(t.text, 'pip: matplotlib 3.10.1, pandas 2.2.3 · npm: csv-parse')
    assert.deepEqual(t.system, ['poppler-utils'])
    assert.equal(t.built, "Analyst's own image layer, built 5:33 PM")
    assert.equal(toolsLine(vmInfo({ tools: undefined, packages: [] }), 'Analyst', NOW), null)
  })
})

describe('vm tab: where files live (Windows only on storage.backend wsl)', () => {
  it('Mac: local path and the shared VM line, no backup or export', () => {
    const f = filesLive(vmInfo(), 'Analyst', 'mac', macHost(), NOW)
    assert.equal(f.before, 'On this Mac in ')
    assert.match(f.after, /Shared VM "agentcontrol": 6 GB RAM · 4 vCPU · disk 21 of 60 GB used/)
    assert.equal(f.backup, null)
    assert.equal(f.exportLabel, null)
  })
  it('WSL: explorer path, backup line and Export only', () => {
    const f = filesLive(winVm(), 'Analyst', 'windows', winHost(), NOW)
    assert.match(f.before, /WSL/)
    assert.match(f.code, /^\\\\wsl\$/)
    assert.match(f.backup, /Last backup today 3:00 AM/)
    assert.equal(f.exportLabel, "Export Analyst's files (.zip)")
  })
  it('a Windows host with local storage gets the local variant', () => {
    const f = filesLive(vmInfo(), 'Analyst', 'windows', winHost(), NOW)
    assert.equal(f.backup, null)
    assert.equal(f.exportLabel, null)
  })
  it('markup: Export link only with wsl; never Back up / Restore (M1)', () => {
    const mac = text(html())
    assert.doesNotMatch(mac, /Export|Restore|Back up/)
    const win = html(model(winVm(), { host: winHost() }))
    assert.match(win, /<a class="btn" href="\/api\/agents\/analyst\/export" download="">Export Analyst&#x27;s files \(.zip\)<\/a>/)
    assert.doesNotMatch(text(win), /Restore|Back up now/)
  })
})

describe('vm tab: history (GAP-V8)', () => {
  const ctx = { botName: 'Analyst', budgetBytes: 2 * GB, groupNames: { 'g-q3': 'Q3 report' }, byId: {}, now: NOW }
  it('mockup rows: undo, group, failed, undone, budget gone, expired', () => {
    const rows = mockRuns().map((r) => historyRow(r, ctx))
    assert.deepEqual(rows.map((r) => r.action), ['undo', 'undo', 'output', 'output', 'none', 'none'])
    assert.equal(rows[0].meta, '3 files changed · 4.2 s · DM')
    assert.equal(rows[0].time, '5:33 PM')
    assert.match(rows[1].meta, /Q3 report$/)
    assert.match(rows[2].meta, /^exit 1/)
    assert.equal(rows[2].iconTone, 'bad')
    assert.match(rows[3].meta, /^undone 3:10 PM · 6 files restored/)
    assert.equal(rows[4].meta, 'Undo no longer available: snapshot removed to stay within the 2 GB undo budget')
    assert.equal(rows[4].time, 'Yesterday')
    assert.equal(rows[5].gone, true)
    assert.equal(rows[5].time, 'Oct 14')
  })
  it('running, tool build and undo rows', () => {
    assert.equal(historyRow(runRow('r', { status: 'running', endedAt: undefined }), ctx).iconTone, 'run')
    assert.equal(historyRow(runRow('t', { kind: 'tool_build', argv: ['pip', 'install', 'x'] }), ctx).name, 'Tool build')
    assert.equal(historyRow(runRow('t', { kind: 'tool_build' }), ctx).action, 'output', 'tool builds have no undo')
    const of = runRow('clean', { argv: ['python3', 'clean.py'] })
    assert.equal(historyRow(runRow('u', { kind: 'undo', undoOfRunId: 'clean' }), { ...ctx, byId: { clean: of } }).name, 'Undo of clean.py')
  })
  it('historyTime: today clock, Yesterday, month day', () => {
    assert.equal(historyTime(new Date(2026, 9, 20, 9, 5).toISOString(), NOW), '9:05 AM')
    assert.equal(historyTime(new Date(2026, 9, 19, 9, 5).toISOString(), NOW), 'Yesterday')
    assert.equal(historyTime(new Date(2026, 9, 3).toISOString(), NOW), 'Oct 3')
  })
  it('model merges older pages without duplicates; runActive', () => {
    const m = model(vmInfo(), { olderRuns: [runRow('clean'), runRow('older1')] })
    assert.equal(m.rows.length, 7)
    assert.equal(m.runActive, false)
    assert.equal(model(vmInfo({ runs: [runRow('r', { status: 'running' })] })).runActive, true)
  })
  it('markup: Undo / Output buttons, no undo, Show older runs', () => {
    const out = html(model(), ui({ hasMore: true }))
    assert.equal((out.match(/>Undo</g) ?? []).length, 2)
    assert.equal((out.match(/>Output</g) ?? []).length, 2)
    assert.equal((out.match(/class="vm-gone"/g) ?? []).length, 2)
    assert.match(out, />Show older runs</)
    assert.match(text(out), /undo for the last 20 runs or 7 days · up to 2 GB/)
  })
})

describe('vm tab: notices (GAP-V5)', () => {
  it('over quota, grow offer and copy driver', () => {
    const vm = vmInfo({ usage: { ...vmInfo().usage, personalBytes: 10.4 * GB }, storage: { ...vmInfo().storage, driver: 'copy' } })
    const host = macHost({ machine: { ...macHost().machine, diskUsedGb: 52, growOffer: { toGb: 100 } } })
    const n = vmNotices(vm, 'Analyst', host)
    assert.deepEqual(n.map((x) => x.id), ['over_quota', 'grow', 'copy_driver'])
    assert.match(n[0].text, /10.4 of 10 GB/)
    assert.deepEqual(n[1].action, { label: 'Grow disk to 100 GB', toGb: 100 })
    assert.deepEqual(vmNotices(vmInfo(), 'Analyst', macHost()), [])
  })
  it('the grow button waits for runs to finish', () => {
    const host = macHost({ machine: { ...macHost().machine, growOffer: { toGb: 100 } } })
    const busy = html(model(vmInfo({ runs: [runRow('r', { status: 'running' })] }), { host }))
    assert.match(busy, /<button type="button" class="btn" disabled="">Grow disk to 100 GB/)
  })
})

describe('vm tab: permissions (M1)', () => {
  it('Internet segmented, Browser toggle disabled with the later-update note, home network blocked', () => {
    const out = html()
    assert.match(out, /aria-label="Internet for scripts"/)
    assert.match(out, /aria-checked="true" class="segmented__opt segmented__opt--on"[^>]*>Ask each time</)
    assert.match(out, /role="switch" aria-checked="false" aria-label="Browser \(Playwright\)" disabled=""/)
    assert.match(text(out), /Turning the browser on is available in a later update\./)
    assert.match(out, />Blocked in Phase 2</)
  })
})

describe('vm tab: whole markup', () => {
  it('cards in mockup order; header buttons by state', () => {
    const out = text(html())
    const order = ["Analyst's VM", 'Permissions', 'Isolation', "Where Analyst's files live", "Analyst's environment", 'Run history']
    let last = -1
    for (const t of order) {
      const i = out.indexOf(t)
      assert.ok(i > last, `${t} after the previous card`)
      last = i
    }
    assert.match(out, /Stop/)
    assert.match(out, /Reset VM…/)
    const stopped = text(html(model(vmInfo({ state: 'stopped' }))))
    assert.match(stopped, / Start /)
    assert.doesNotMatch(stopped, / Stop /)
  })
  it('section errors render inline as alerts', () => {
    const out = html(model(), ui({ errors: { perm: 'The browser arrives in a later update.' } }))
    assert.match(out, /<p class="vm-err" role="alert">The browser arrives in a later update\.<\/p>/)
  })
  it('no comingSoon anywhere on the tab', () => {
    assert.doesNotMatch(html(), /[Cc]oming soon/)
  })
})

describe('vm tab: misc', () => {
  it('tab dot: ● running/starting, ! needs attention, nothing otherwise (GAP-V10)', () => {
    assert.equal(vmTabDot(vmInfo()).text, '●')
    assert.equal(vmTabDot(vmInfo({ state: 'starting' })).text, '●')
    assert.equal(vmTabDot(vmInfo({ state: 'error' })).text, '!')
    assert.equal(vmTabDot(vmInfo({ state: 'files_missing' })).text, '!')
    assert.equal(vmTabDot(vmInfo({ state: 'stopped', runtime: { ...vmInfo().runtime, status: 'required_unavailable' } })).text, '!')
    assert.equal(vmTabDot(vmInfo({ state: 'stopped' })), null)
    assert.equal(vmTabDot(undefined), null)
  })
  it('reset copy and action errors', () => {
    assert.equal(RESET_TITLE('Analyst'), "Reset Analyst's VM?")
    assert.equal(RESET_TEXT, 'Your files are kept. Installed tools and packages will be removed.')
    assert.doesNotMatch(RESET_TEXT, /backup/i)
    assert.match(RESET_ACTIVE_TEXT, /run is going on/)
    assert.equal(vmActionError({ status: 400, message: '"PATH" is reserved.' }, 'x'), '"PATH" is reserved.')
    assert.equal(vmActionError({ status: 500, message: 'boom' }, 'fallback'), 'fallback')
    assert.equal(vmActionError(new TypeError('Failed to fetch'), 'fallback'), 'fallback')
  })
  it('every GAP is listed', () => {
    assert.deepEqual(Object.keys(VM_TAB_GAPS), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12'])
  })
  it('VmTab.tsx wires the real routes (loadRun before Undo/Output, putVm after writes)', () => {
    const src = readFileSync(new URL('../src/components/settings/VmTab.tsx', import.meta.url), 'utf8')
    for (const s of ['loadRun(id)', 'putVm(await api.vm.startVm', 'api.vm.resetVm', 'api.vm.recheckProbe', 'api.vm.growMachine', 'api.vm.listRuns', 'api.vm.getVmTools', 'rollbackTools', 'UndoDialog', 'RunOutputDialog'])
      assert.ok(src.includes(s), s)
  })
})

describe('run history pages (GET /api/agents/:id/script-runs?limit=50)', () => {
  const r = (id) => ({ id })
  it('vm.runs paints first; hasMore only from the server (runsHasMore, then pages)', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => r(`r${i}`))
    assert.deepEqual(vmHistory({ runs: fifty }, null, null), { runs: fifty, hasMore: false, before: 'r49' }, 'no 50-row guess')
    assert.equal(vmHistory({ runs: fifty, runsHasMore: true }, null, null).hasMore, true, 'VmInfo.runsHasMore for first paint')
    assert.equal(vmHistory({ runs: fifty, runsHasMore: true }, { runs: fifty, hasMore: false }, null).hasMore, false, 'the page wins')
  })
  it('the first page brings the real hasMore and merges by id', () => {
    const h = vmHistory({ runs: [r('a'), r('b')] }, { runs: [r('a'), r('b'), r('c')], hasMore: true }, null)
    assert.deepEqual(h.runs.map((x) => x.id), ['a', 'b', 'c'])
    assert.equal(h.hasMore, true)
    assert.equal(h.before, 'c')
    assert.equal(vmHistory({ runs: [r('a')] }, { runs: [r('a')], hasMore: false }, null).hasMore, false)
  })
  it('older pages append and their hasMore wins', () => {
    const h = vmHistory({ runs: [r('a')] }, { runs: [r('a'), r('b')], hasMore: true }, { runs: [r('c')], hasMore: false })
    assert.deepEqual(h.runs.map((x) => x.id), ['a', 'b', 'c'])
    assert.equal(h.hasMore, false)
  })
  it('no rows means no button', () => {
    assert.equal(vmHistory({ runs: [] }, { runs: [], hasMore: true }, null).hasMore, false)
  })
  it('history uses /script-runs; the Phase 1 /runs route (model turns) is left alone', () => {
    assert.equal(vmPaths.agentRuns('a 1'), '/api/agents/a%201/script-runs?limit=50')
    assert.equal(vmPaths.agentRuns('a1', { before: 'r9' }), '/api/agents/a1/script-runs?limit=50&before=r9')
    const tab = readFileSync(new URL('../src/components/settings/VmTab.tsx', import.meta.url), 'utf8')
    assert.doesNotMatch(tab, /isRunHistoryPage/, 'no plain-array guard: the new route only answers {runs, hasMore}')
    const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
    assert.match(api, /\/runs/, 'Phase 1 runs usage still there')
  })
  it('VmTab loads the first page on mount and drops the row-count guess', () => {
    const src = readFileSync(new URL('../src/components/settings/VmTab.tsx', import.meta.url), 'utf8')
    assert.match(src, /api\.vm\.listRuns\(agent\.id\)/)
    assert.doesNotMatch(src, />= RUN_PAGE_SIZE/)
  })
})
