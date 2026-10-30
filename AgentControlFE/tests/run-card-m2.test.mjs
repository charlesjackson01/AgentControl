// FE-P2-9: M2 run card (internet, browser, tool builds) against contract fec4670 and mockups 01–08.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  HOST_BLOCK_LABEL, HOST_BLOCKED_TEXT, HOSTS_SHOWN, M2_RUN_REASONS, RUN_CARD_GAPS, buildSource, hostRows, internetUseOf, reasonErrorText,
  runCardView, statusText, thumbOf, waitLine,
} from '../src/lib/run-card.ts'
import { renderRunCard } from '../src/lib/run-card-render.ts'
import { summaryFromRun } from '../src/lib/live-store.ts'
import { CHAT_RUN_HOSTS_MAX, HOST_BLOCK_REASONS } from '../src/lib/types.ts'
import { M2_CARDS, T0, cardByKey } from './run-card-m2-fixtures.mjs'
import { run, summary } from './live-fixtures.mjs'

const view = (key, extra = {}) => {
  const c = cardByKey(key)
  return runCardView({ run: c.run, summary: c.summary, output: c.output, now: T0, botName: 'Primary', ...extra })
}
const html = (v, x = {}) => renderToStaticMarkup(h('div', null, renderRunCard(v, x)))
const metaOf = (v) => Object.fromEntries(v.meta.map((m) => [m.label, m.value]))

describe('M2 waiting cards (mockups 01, 03, 04, 05)', () => {
  it('waiting for an internet answer: Stop only, no log, the wait line', () => {
    const v = view('01-waiting-internet')
    assert.equal(v.statusText, 'Waiting for permission')
    assert.equal(v.spinner, true)
    assert.deepEqual(metaOf(v), { Internet: 'asked' })
    assert.match(v.wait, /^⏸ Not started\. It starts as soon as you answer below; no answer in 10 min counts as Deny\.$/)
    assert.equal(v.log, null)
    assert.equal(v.note, null)
    assert.deepEqual(v.actions, { stop: true, undo: false, output: false })
  })
  it('browser asked first: the internet asks after the browser', () => {
    assert.deepEqual(metaOf(view('03-waiting-browser-ask')), { Browser: 'asked', Internet: 'asks after the browser' })
    assert.deepEqual(metaOf(view('05-browser-on-internet-asked')), { Browser: 'on', Internet: 'asked' })
  })
  it('waiting for the browser download: own status, no wait line (GAP-R19 meta)', () => {
    const v = view('04-waiting-for-browser')
    assert.equal(v.statusText, 'Waiting for the browser')
    assert.equal(v.wait, null)
    assert.deepEqual(metaOf(v), { Browser: 'on', Internet: 'asks after the browser' })
    assert.ok(RUN_CARD_GAPS.waitingBrowserMeta.startsWith('GAP-R19'))
  })
})

describe('M2 ended cards (mockups 02, 06)', () => {
  it('denied: the server error goes under everything, no meta', () => {
    const v = view('02-denied')
    assert.equal(v.statusText, 'Denied')
    assert.equal(v.error, "You denied internet access, so this run didn't start. No files changed.")
    assert.equal(v.errorLast, true)
    assert.deepEqual(v.meta, [])
  })
  it('network run: Internet value, Sites used reached first, no IP arrows, undo note', () => {
    const v = view('06-network-run')
    assert.equal(metaOf(v).Internet, 'on (always allowed)')
    assert.equal(v.hosts.title, 'Sites used')
    assert.deepEqual(v.hosts.rows.map((r) => [r.label, r.host, r.note]), [
      ['reached', 'api.frankfurter.app', '2 requests'],
      ['reached', 'pypi.org', '1 request'],
      ['blocked', '192.168.1.20:8080', 'home network · 1 try'],
    ])
    assert.equal(v.note, "Undo restores files only. It can't take back what was sent online.")
    const out = html(v)
    assert.doesNotMatch(out, /→|104\.21\.3\.4/)
    assert.match(out, /<ul class="rc-hosts" aria-label="Sites used">/)
  })
  it('browser run: Browser on, allowed once, a screenshot thumbnail through the files route', () => {
    const v = view('06-browser-run')
    assert.deepEqual(metaOf(v), { Exit: '0', Browser: 'on', Internet: 'on (allowed once)', 'Peak memory': '688 MB', Runtime: 'gVisor' })
    assert.deepEqual(v.thumb, { path: 'screenshots/sales-2026-10-30.png', root: 'agent' })
    const out = html(v, { thumbUrl: '/api/agents/a1/files/content?path=x.png' })
    assert.match(out, /<img class="rc-shot"[^>]*alt="Screenshot preview: screenshots\/sales-2026-10-30\.png"/)
    assert.doesNotMatch(html(v), /rc-shot/, 'no URL, no image')
  })
})

describe('M2 tool build and queued (mockup 07)', () => {
  it('running build: no command, Internet + Started by, live log, Stop note keeps the old version', () => {
    const v = view('07-tool-build-running')
    assert.equal(v.name, 'Rebuild tools')
    assert.equal(v.source, 'adds matplotlib, pandas · version 3')
    assert.equal(v.statusText, 'Running · 1:12')
    assert.equal(v.command, null)
    assert.deepEqual(metaOf(v), { Internet: 'on (allowed once)', 'Started by': 'Primary (vm_install)' })
    assert.equal(v.hosts.title, 'Sites used so far')
    assert.equal(v.log.live, true)
    assert.equal(v.note, 'Stopping keeps the current tools (version 2).')
    assert.deepEqual(v.files, [])
  })
  it('build started by you; summary.startedAt ticks a collapsed card', () => {
    const c = cardByKey('07-tool-build-running')
    const mine = { ...c.run.build, startedBy: 'user', via: 'rebuild' }
    assert.equal(metaOf(runCardView({ run: { ...c.run, build: mine }, now: T0, botName: 'Primary' }))['Started by'], 'you')
    assert.equal(runCardView({ summary: c.summary, now: T0, botName: 'Primary' }).statusText, 'Running · 1:12')
  })
  it('queued behind a tool build: own status and the ⏳ wait line with the new version', () => {
    const v = view('07-queued-after-build')
    assert.equal(v.statusText, 'Queued · after tool build')
    assert.equal(v.wait, "⏳ Waits for Primary's tools to finish building, then runs on the new tools (version 3).")
    assert.equal(v.note, null)
    assert.deepEqual(v.actions, { stop: true, undo: false, output: false })
    assert.equal(waitLine('queued', undefined, summary({ status: 'queued', queuedReason: 'tool_build' })), "⏳ Waits for the bot's tools to finish building, then runs on the new tools.")
    assert.equal(waitLine('queued', undefined, summary({ status: 'queued', queuedReason: 'slot' })), null)
    assert.equal(statusText('queued', { queuePosition: 2, queuedReason: 'slot' }), runCardView({ summary: summary({ status: 'queued', queuePosition: 2 }) }).statusText)
  })
  it('buildSource lists adds, removes and the version', () => {
    assert.equal(buildSource({ generation: 4, fromGeneration: 3, packages: [], added: ['jq'], removed: ['curl', 'git'], startedBy: 'user', via: 'rebuild', base: 'base' }), 'adds jq · removes curl, git · version 4')
    assert.equal(buildSource({ generation: 2, fromGeneration: 1, packages: [], added: [], startedBy: 'user', via: 'browser', base: 'browser' }), 'version 2')
  })
})

describe('M2 error cards (mockup 08)', () => {
  it('server error text wins, under the red log; no note', () => {
    for (const key of ['08-internet-never', '08-network-off', '08-build-failed', '08-proxy-unavailable']) {
      const v = view(key)
      assert.equal(v.error, cardByKey(key).run.error, key)
      assert.equal(v.errorLast, true, key)
      assert.equal(v.note, null, key)
    }
    assert.equal(view('08-build-failed').statusText, 'Failed · 0:41')
    assert.deepEqual(metaOf(view('08-network-off')), { Exit: '1', Internet: 'off' })
  })
  it('host_blocked keeps exit + internet, the blocked row and the undo note', () => {
    const v = view('08-host-blocked')
    assert.deepEqual(metaOf(v), { Exit: '1', Internet: 'on (always allowed)' })
    assert.deepEqual(v.hosts.rows.map((r) => [r.blocked, r.note]), [[true, 'Tailscale · 1 try']])
    assert.equal(v.log.error, true)
    assert.equal(v.note, "Undo restores files only. It can't take back what was sent online.")
    const out = html(v)
    assert.ok(out.indexOf('rc-log') < out.indexOf(v.error), 'error line under the log')
  })
  it('fallback text for every M2 reason when the run has no error', () => {
    assert.equal(M2_RUN_REASONS.length, 10)
    for (const r of M2_RUN_REASONS) assert.ok(reasonErrorText(r, { botName: 'Primary', hosts: [{ host: 'x', count: 1, blocked: true, reason: 'tailscale' }] }), r)
    assert.equal(reasonErrorText('host_blocked', {}), null, 'no blocked host, no guess')
    assert.equal(reasonErrorText('permission_timeout', {}), "No answer in 10 minutes, so this run didn't start. No files changed.")
    assert.equal(reasonErrorText('permission_denied', { browser: true }), "You denied the browser, so this run didn't start. No files changed.")
    assert.match(reasonErrorText('build_failed', { botName: 'Primary', status: 'timed_out', build: { fromGeneration: 2 } }), /longer than 20 minutes.*version 2/)
    assert.equal(reasonErrorText('host_blocked', { hosts: [{ host: 'x', count: 1, blocked: true, reason: 'metadata' }] }), HOST_BLOCKED_TEXT.metadata)
    assert.equal(reasonErrorText('something_else', {}), null)
  })
  it('every block reason has a label and a sentence', () => {
    for (const r of HOST_BLOCK_REASONS) {
      assert.ok(HOST_BLOCK_LABEL[r], r)
      assert.match(HOST_BLOCKED_TEXT[r], /blocked/, r)
    }
  })
})

describe('Sites used rows', () => {
  it('reached first, then blocked; :port only when not 443; never the ip', () => {
    const r = hostRows([
      { host: 'b.lan', count: 3, blocked: true, reason: 'private_name' },
      { host: 'a.com', port: 443, ip: '1.2.3.4', count: 1, blocked: false },
      { host: 'c.com', port: 8443, ip: '5.6.7.8', count: 2, blocked: false },
    ])
    assert.deepEqual(r.rows.map((x) => x.host), ['a.com', 'c.com:8443', 'b.lan'])
    assert.equal(r.rows[2].note, `${HOST_BLOCK_LABEL.private_name} · 3 tries`)
    assert.ok(!JSON.stringify(r).includes('1.2.3.4'))
  })
  it('none → null; over the cap → "+ N more" from the total (GAP-R17)', () => {
    assert.equal(hostRows(undefined), null)
    assert.equal(hostRows([]), null)
    const v = view('GAP-hosts-more')
    assert.equal(v.hosts.rows.length, HOSTS_SHOWN)
    assert.equal(v.hosts.more, 31 - HOSTS_SHOWN)
    assert.match(html(v), /\+ 23 more sites/)
    assert.equal(hostRows([{ host: 'a', count: 1, blocked: false }]).more, 0)
  })
})

describe('thumbnail rules', () => {
  const br = (files, extra = {}) => run('t', { browser: true, status: 'succeeded', filesChanged: files, ...extra })
  it('first added/modified png/jpg/jpeg/webp; never svg or deleted; browser runs only; none once undone', () => {
    assert.deepEqual(thumbOf(br([{ path: 'a.svg', change: 'added' }, { path: 'b.png', change: 'deleted' }, { path: 'c.JPEG', change: 'modified', root: 'group', groupId: 'g1' }]), false), { path: 'c.JPEG', root: 'group', groupId: 'g1' })
    assert.equal(thumbOf(br([{ path: 'a.svg', change: 'added' }, { path: 'x.gif', change: 'added' }]), false), null)
    assert.equal(thumbOf(br([{ path: 'a.webp', change: 'added' }]), true), null)
    assert.equal(thumbOf(run('t', { browser: false, filesChanged: [{ path: 'a.png', change: 'added' }] }), false), null)
  })
})

describe('internet use', () => {
  it('summary first, else the run permissions, else on/off', () => {
    assert.equal(internetUseOf(undefined, summary({ internet: 'once' })), 'once')
    assert.equal(internetUseOf(run('i', { network: 'on', permissions: [{ type: 'internet', decision: 'always', source: 'policy' }] }), undefined), 'always')
    assert.equal(internetUseOf(run('i', { network: 'on', permissions: [{ type: 'internet', decision: 'allow_once', requestId: 'p' }] }), undefined), 'once')
    assert.equal(internetUseOf(run('i', { network: 'off' }), undefined), 'off')
    assert.equal(internetUseOf(run('i', { network: 'on' }), undefined), 'on')
  })
})

describe('summaryFromRun (M2 fields)', () => {
  it('copies the M2 fields and caps hosts at CHAT_RUN_HOSTS_MAX', () => {
    const hosts = Array.from({ length: 25 }, (_, i) => ({ host: `h${i}.com`, count: 1, blocked: false }))
    const r = run('s1', { network: 'on', browser: true, status: 'failed', reason: 'host_blocked', error: 'E', startedAt: '2026-10-30T14:00:00.000Z', durationMs: 5, hostsContacted: hosts, hostsContactedTotal: 40 })
    const s = summaryFromRun(r, summary({ internet: 'always' }))
    assert.equal(s.network, 'on')
    assert.equal(s.browser, true)
    assert.equal(s.reason, 'host_blocked')
    assert.equal(s.error, 'E')
    assert.equal(s.internet, 'always')
    assert.equal(s.hostsContacted.length, CHAT_RUN_HOSTS_MAX)
    assert.equal(s.hostsContactedTotal, 40)
    assert.equal(s.waitingFor, undefined)
  })
  it('keeps the queued reason only while queued; waitingFor only while waiting', () => {
    const prev = summary({ status: 'queued', queuedReason: 'tool_build', afterBuild: { runId: 'tb', generation: 3 } })
    assert.equal(summaryFromRun(run('q', { status: 'queued' }), prev).queuedReason, 'tool_build')
    assert.deepEqual(summaryFromRun(run('q', { status: 'queued' }), prev).afterBuild, { runId: 'tb', generation: 3 })
    assert.equal(summaryFromRun(run('q', { status: 'running' }), prev).queuedReason, undefined)
    assert.equal(summaryFromRun(run('w', { status: 'waiting_permission', waitingFor: 'browser' })).waitingFor, 'browser')
    assert.equal(summaryFromRun(run('w', { status: 'running', waitingFor: 'browser' })).waitingFor, undefined)
  })
})

describe('every mocked state renders', () => {
  it('each fixture card renders without throwing and labels itself', () => {
    for (const c of M2_CARDS) {
      const out = html(runCardView({ run: c.run, summary: c.summary, output: c.output, now: T0, botName: 'Primary' }))
      assert.match(out, /role="group"/, c.key)
      if (c.gap) assert.ok(RUN_CARD_GAPS[c.gap], c.key)
    }
  })
})
