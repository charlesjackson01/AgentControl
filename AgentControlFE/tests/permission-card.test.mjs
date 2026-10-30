// FE-P2-3: permission card logic (src/lib/permission-card.ts), markup (permission-card-render.ts), and the
// live-store / live-events / vm-api / controller additions for M2 contract fec4670.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AFTER_BROWSER_LINE, BUILD_PENDING_LINE, GROUP_FOOT, NET_FOOT, PENDING_LINE, PERMISSION_CARD_GAPS,
  actionErrorText, mbText, pendingLine, permissionCardView, sendErrorText, setupSteps, setupVmAgent, sizeText, spanText, timerText,
} from '../src/lib/permission-card.ts'
import { renderPermissionCard } from '../src/lib/permission-card-render.ts'
import { LOW_DISK_TEXT } from '../src/lib/low-disk.ts'
import { initialLiveState, liveReducer, permissionFor, pendingPermissions } from '../src/lib/live-store.ts'
import { createLiveController } from '../src/lib/live-controller.ts'
import { readLiveFrame } from '../src/lib/live-events.ts'
import { createVmApi, permissionErrorOf, vmPaths } from '../src/lib/vm-api.ts'
import { clockTime } from '../src/lib/thread.ts'
import { PERMISSION_HOSTS_MAX } from '../src/lib/types.ts'
import { permission, run } from './live-fixtures.mjs'

const T = (h, m, s = 0) => new Date(2026, 9, 30, h, m, s).toISOString()
const ms = (iso) => Date.parse(iso)
const text = (segs) => segs.map((s) => (typeof s === 'string' ? s : s.code ?? s.b ?? s.text)).join('')
const html = (v, x) => renderToStaticMarkup(renderPermissionCard(v, x))

const netAsk = (extra = {}) => permission('p1', {
  scriptName: 'fetch_rates.py', why: "Download this week's EUR/USD rates for the Q3 report.", hosts: ['api.frankfurter.app'],
  createdAt: T(9, 40), expiresAt: T(9, 50), ...extra,
})
const brAsk = (extra = {}) => permission('b1', {
  type: 'browser', hosts: undefined, scriptName: 'snap_dashboard.py', why: 'Open your sales dashboard and save a screenshot.',
  internetNext: true, createdAt: T(9, 50), expiresAt: T(10, 0), ...extra,
})
const setup = (extra = {}) => ({
  turnedOnAt: T(9, 51), turnedOnBy: 'user', requestId: 'b1', runId: 'r1',
  download: { startedAt: T(9, 51), bytes: 620e6, totalBytes: 1343e6 }, rebuild: {}, check: { status: 'pending' }, ...extra,
})
const view = (request, extra = {}) => permissionCardView({ request, botName: 'Primary', nowMs: ms(T(9, 40, 19)), ...extra })

describe('formatting', () => {
  it('timer, sizes, spans', () => {
    assert.equal(timerText(48_000), '0:48')
    assert.equal(timerText(591_200), '9:52')
    assert.equal(timerText(-5_000), '0:00')
    assert.equal(mbText(620e6), '620 MB')
    assert.equal(mbText(840e6), '840 MB')
    assert.equal(sizeText(1343e6), '1.3 GB')
    assert.equal(sizeText(600e6), '600 MB')
    assert.equal(spanText(T(9, 51), T(9, 52, 42)), '1 min 42 s')
    assert.equal(spanText(T(9, 53), T(9, 53, 52)), '52 s')
    assert.equal(spanText(undefined, T(9, 53)), null)
  })
  it('send error (mockup 10): network → "could not reach the API server"; else the server message', () => {
    assert.equal(sendErrorText(new TypeError('Failed to fetch')), "Couldn't send your answer: could not reach the API server. Try again.")
    assert.equal(sendErrorText(new Error('Server busy.')), "Couldn't send your answer: server busy. Try again.")
    assert.equal(sendErrorText(null), "Couldn't send your answer: could not reach the API server. Try again.")
  })
})

describe('internet card · pending (mockup 01, 10, 05)', () => {
  it('DM: title, sub, hosts, buttons, footer with link, timer', () => {
    const v = view(netAsk())
    assert.equal(v.mode, 'pending')
    assert.equal(v.title, 'Primary wants to use the internet')
    assert.equal(text(v.sub), `To run fetch_rates.py: “Download this week's EUR/USD rates for the Q3 report.” ${PENDING_LINE}`)
    assert.deepEqual(v.sub[1], { code: 'fetch_rates.py' })
    assert.equal(v.hostsLabel, 'Expects to reach')
    assert.deepEqual(v.hosts, ['api.frankfurter.app'])
    assert.deepEqual(v.buttons.map((b) => [b.label, b.decision, b.cls]), [
      ['Allow once', 'allow_once', 'primary'], ['Always for Primary', 'always', 'plain'], ['Deny', 'deny', 'ghost'],
    ])
    assert.equal(text(v.foot), `${NET_FOOT} Settings › VM`)
    assert.deepEqual(v.foot.at(-1), { link: 'settings', text: 'Settings › VM' })
    assert.equal(v.timer, '9:41 left')
    assert.equal(v.timerLow, false)
  })
  it('the countdown is low at ≤ 60 s (0:48 in mockup 09) and uses the skew-corrected now', () => {
    const v = view(netAsk(), { nowMs: ms(T(9, 49, 12)) })
    assert.equal(v.timer, '0:48 left')
    assert.equal(v.timerLow, true)
  })
  it('group (mockup 10): "in <group>", no pending sentence, group sentence before the footer, no link', () => {
    const v = view(netAsk({ groupId: 'g1', groupName: 'Q3 report', why: "Download this week's EUR/USD rates." }))
    assert.equal(text(v.sub), "To run fetch_rates.py in Q3 report: “Download this week's EUR/USD rates.”")
    assert.equal(text(v.foot), `${GROUP_FOOT} ${NET_FOOT}`)
    assert.equal(v.foot.some((s) => typeof s === 'object'), false)
    // older rows without groupName fall back to the page's group name
    assert.equal(text(view(netAsk({ groupId: 'g1' }), { groupName: 'Ops' }).sub).includes(' in Ops'), true)
  })
  it('after a browser card on the same run (mockup 05): browser sentence, footer without link', () => {
    const v = view(netAsk({ scriptName: 'snap_dashboard.py', why: 'Open the sales dashboard and save a screenshot.', hosts: ['dash.example.com'] }), { afterBrowser: true })
    assert.equal(text(v.sub), `To run snap_dashboard.py: “Open the sales dashboard and save a screenshot.” ${AFTER_BROWSER_LINE}`)
    assert.equal(text(v.foot), NET_FOOT)
  })
  it('no why: a plain sentence; hosts are plain text, capped at PERMISSION_HOSTS_MAX', () => {
    assert.equal(text(view(netAsk({ why: undefined })).sub), `To run fetch_rates.py. ${PENDING_LINE}`)
    const many = Array.from({ length: 12 }, (_, i) => `h${i}.example.com`)
    const v = view(netAsk({ hosts: many }))
    assert.equal(v.hosts.length, PERMISSION_HOSTS_MAX)
    assert.equal(v.moreHosts, 2)
    const v0 = view(netAsk({ hosts: [] }))
    assert.equal(v0.hostsLabel, null)
  })
  it('tool build (GAP): "To build Primary\'s tools", build sentence', () => {
    const v = view(netAsk({ runKind: 'tool_build', scriptName: undefined, why: undefined }))
    assert.equal(text(v.sub), "To build Primary's tools. Nothing in this build reaches the internet until you choose.")
  })
  it('send error (mockup 09): shows under the buttons, and the pending sentence is left out', () => {
    const v = view(netAsk({ why: "Download this week's EUR/USD rates." }), { sendError: sendErrorText(new TypeError('Failed to fetch')) })
    assert.equal(v.error, "Couldn't send your answer: could not reach the API server. Try again.")
    assert.equal(text(v.sub), "To run fetch_rates.py: “Download this week's EUR/USD rates.”")
    assert.equal(text(v.foot), `${NET_FOOT} Settings › VM`)
  })
  it('pendingLine: DM 01, after-browser 05, tool build; none in groups (10), with a send error (09), or on browser cards', () => {
    const p = (req, extra = {}) => pendingLine({ request: netAsk(req), botName: 'Primary', nowMs: 0, ...extra })
    assert.equal(p(), PENDING_LINE)
    assert.equal(p({}, { nowMs: ms(T(9, 49, 12)) }), PENDING_LINE) // low timer alone keeps it (no mockup leaves it out)
    assert.equal(p({}, { afterBrowser: true }), AFTER_BROWSER_LINE)
    assert.equal(p({ runKind: 'tool_build', scriptName: undefined }), BUILD_PENDING_LINE)
    assert.equal(p({ groupId: 'g1', groupName: 'Q3 report' }), null)
    assert.equal(p({ groupId: 'g1', groupName: 'Q3 report' }, { afterBrowser: true }), null)
    assert.equal(p({ runKind: 'tool_build', groupId: 'g1' }), null)
    assert.equal(p({}, { sendError: 'E' }), null)
    assert.equal(p({}, { afterBrowser: true, sendError: 'E' }), null)
    assert.equal(p({ type: 'browser', hosts: undefined }), null)
  })
  it('no why and no sentence: just the run reference', () => {
    assert.equal(text(view(netAsk({ why: undefined, groupId: 'g1', groupName: 'Q3 report' })).sub), 'To run fetch_rates.py in Q3 report.')
    assert.equal(text(view(netAsk({ why: undefined }), { sendError: 'E' }).sub), 'To run fetch_rates.py.')
  })
})

describe('internet card · resolved (mockup 02, 09)', () => {
  const done = (status, extra = {}) => view(netAsk({ status, resolvedAt: T(9, 41), resolvedBy: 'user', ...extra }))
  it('allowed once', () => {
    const v = done('allowed_once')
    assert.equal(text(v.title), 'Internet allowed for fetch_rates.py')
    assert.equal(text(v.sub), `You allowed this run at ${clockTime(T(9, 41))}. Primary asks again next time.`)
    assert.deepEqual([v.pill, v.tone], ['✓ Allowed once', 'ok'])
  })
  it('always', () => {
    const v = done('always', { resolvedAt: T(9, 44) })
    assert.equal(text(v.title), 'Internet always allowed for Primary')
    assert.equal(text(v.sub), `You chose this at ${clockTime(T(9, 44))}, so Primary's Internet rule is now Always allow. Change it in Settings › VM.`)
    assert.deepEqual(v.sub[1], { b: 'Always allow' })
    assert.deepEqual([v.pill, v.tone], ['✓ Always for Primary', 'ok'])
  })
  it('denied', () => {
    const v = done('denied', { resolvedAt: T(9, 47) })
    assert.equal(text(v.title), 'Internet denied for fetch_rates.py')
    assert.equal(text(v.sub), `You denied it at ${clockTime(T(9, 47))}. Primary was told “The user declined internet access.”`)
    assert.deepEqual([v.pill, v.tone], ['✕ Denied', 'bad'])
  })
  it('expired', () => {
    const v = done('timeout', { resolvedAt: T(10, 3), resolvedBy: undefined })
    assert.equal(text(v.title), 'Internet request expired')
    assert.equal(text(v.sub), `No answer in 10 minutes, so it counted as Deny (${clockTime(T(10, 3))}). Primary can ask again if you want it to.`)
    assert.deepEqual([v.pill, v.tone], ['Expired', 'off'])
  })
  it('tool build allowed', () => {
    const v = done('allowed_once', { runKind: 'tool_build', scriptName: undefined, resolvedAt: T(10, 12) })
    assert.equal(text(v.title), 'Internet allowed for the tool build')
    assert.equal(text(v.sub), `You allowed it at ${clockTime(T(10, 12))}. Only this build gets the internet.`)
  })
  it('closedBy (GAP): run_stopped, run_ended, policy_changed', () => {
    const stopped = done('denied', { closedBy: 'run_stopped', resolvedBy: undefined })
    assert.equal(text(stopped.title), 'Internet request closed')
    assert.equal(text(stopped.sub), `fetch_rates.py was stopped before you answered (${clockTime(T(9, 41))}).`)
    assert.deepEqual([stopped.pill, stopped.tone], ['Closed', 'off'])
    assert.equal(text(done('denied', { closedBy: 'run_ended' }).sub).includes(' ended before you answered'), true)
    assert.equal(text(done('denied', { closedBy: 'policy_changed' }).sub), "Primary's Internet rule changed in Settings › VM while this waited, so it closed.")
  })
  it('409 (mockup 09): the real status with "already answered in another window"', () => {
    const v = done('denied', { resolvedAt: T(9, 43) })
    const x = view(netAsk({ status: 'denied', resolvedAt: T(9, 43), resolvedBy: 'user' }), { answeredElsewhere: true })
    assert.equal(text(x.title), text(v.title))
    assert.equal(text(x.sub), `This was already answered in another window (Denied at ${clockTime(T(9, 43))}).`)
    assert.equal(x.pill, '✕ Denied')
    const a = view(netAsk({ status: 'always', resolvedAt: T(9, 43) }), { answeredElsewhere: true })
    assert.equal(text(a.sub).includes('(Always for Primary at '), true)
  })
})

describe('browser card (mockups 03, 04, 05, 09)', () => {
  it('pending (03)', () => {
    const v = view(brAsk(), { nowMs: ms(T(9, 50, 8)) })
    assert.equal(v.title, 'Primary wants to use a browser')
    assert.equal(text(v.sub), 'To run snap_dashboard.py it needs headless Chromium (Playwright) to open your sales dashboard and save a screenshot. The browser is off for Primary.')
    assert.equal(text(v.foot), "Turning it on downloads Chromium once (about 1.3 GB, shared by all bots, not counted in Primary's 10 GB). The page is on the internet, so Primary's Ask each time rule asks next. Settings › VM")
    assert.deepEqual(v.buttons.map((b) => [b.label, b.decision, b.cls]), [['Turn on browser for Primary', 'enable', 'primary'], ['Deny', 'deny', 'ghost']])
    assert.equal(v.timer, '9:52 left')
    assert.equal(v.hostsLabel, null)
    // no internet next: no "asks next" sentence
    assert.equal(text(view(brAsk({ internetNext: false })).foot).includes('asks next'), false)
  })
  it('setting up, download step (04) with live bytes from browser.updated', () => {
    const r = brAsk({ status: 'enabled', resolvedAt: T(9, 51), setup: setup() })
    const v = view(r)
    assert.equal(text(v.title), 'Turning on the browser for Primary')
    assert.equal(text(v.sub), "snap_dashboard.py waits until it's ready. You can keep chatting.")
    assert.deepEqual([v.pill, v.tone], ['Setting up', 'run'])
    assert.deepEqual(v.steps.map((s) => [s.state, s.label, s.meta ?? '']), [
      ['ok', 'Turned on for Primary by you', clockTime(T(9, 51))],
      ['run', 'Downloading headless Chromium', '620 MB of 1.3 GB · 46%'],
      ['dim', "Rebuild Primary's tools on the browser base", ''],
      ['dim', "Restart Primary's VM and check Chromium", ''],
    ])
    assert.equal(v.steps[1].progress, 46)
    assert.equal(v.next, 'Next: Primary asks for the internet, because the page is online.')
    const live = view(r, { browser: { state: 'downloading', bytes: 700e6, totalBytes: 1343e6, usedBy: [] } })
    assert.equal(live.steps[1].meta, '700 MB of 1.3 GB · 52%')
    // an older browser.updated never moves the bar back
    assert.equal(view(r, { browser: { state: 'downloading', bytes: 100e6, totalBytes: 1343e6, usedBy: [] } }).steps[1].meta, '620 MB of 1.3 GB · 46%')
  })
  it('setting up, build step (04): downloaded + rebuilding clock', () => {
    const s = setup({ download: { startedAt: T(9, 51), endedAt: T(9, 52, 42), bytes: 1343e6, totalBytes: 1343e6 }, rebuild: { runId: 'tb1', startedAt: T(9, 53) } })
    const v = view(brAsk({ status: 'enabled', resolvedAt: T(9, 51), setup: s }), { nowMs: ms(T(9, 53, 38)) })
    assert.deepEqual(v.steps.slice(1).map((x) => [x.state, x.label, x.meta ?? '']), [
      ['ok', 'Downloaded headless Chromium', '1.3 GB · 1 min 42 s'],
      ['run', "Rebuilding Primary's tools on the browser base", '0:38'],
      ['dim', "Restart Primary's VM and check Chromium", ''],
    ])
  })
  it('GAP steps: reused download, rebuilt, restarting (waiting_idle)', () => {
    const s = setup({ download: { reused: true }, rebuild: { startedAt: T(9, 51), endedAt: T(9, 52) } })
    const steps = setupSteps({ request: brAsk(), botName: 'Primary', nowMs: ms(T(9, 52, 5)), botBrowserState: 'waiting_idle' }, s)
    assert.deepEqual(steps.slice(1).map((x) => [x.state, x.label, x.meta ?? '']), [
      ['ok', 'Headless Chromium already downloaded', ''],
      ['ok', "Rebuilt Primary's tools on the browser base", '1 min'],
      ['run', "Restarting Primary's VM and checking Chromium", 'after the current run'],
    ])
  })
  it('enabled before any setup snapshot: the first step only, download at 0%', () => {
    const v = view(brAsk({ status: 'enabled', resolvedAt: T(9, 51) }))
    assert.equal(v.steps[0].meta, clockTime(T(9, 51)))
    assert.equal(v.steps[1].meta, '0 MB of 1.3 GB · 0%')
  })
  it('ready (05)', () => {
    const s = setup({
      download: { startedAt: T(9, 51), endedAt: T(9, 52, 42), totalBytes: 1343e6 }, rebuild: { startedAt: T(9, 53), endedAt: T(9, 53, 52) },
      check: { status: 'pass', at: T(9, 54) }, readyAt: T(9, 54),
    })
    const v = view(brAsk({ status: 'enabled', resolvedAt: T(9, 51), setup: s }))
    assert.equal(text(v.title), 'Browser on for Primary')
    assert.equal(text(v.sub), `Turned on by you at ${clockTime(T(9, 51))} · ready at ${clockTime(T(9, 54))} (download 1 min 42 s, rebuild 52 s, Chromium check passed).`)
    assert.deepEqual([v.pill, v.tone], ['✓ Browser on', 'ok'])
    assert.equal(v.steps.length, 0)
  })
  const failed = (setupError) => view(brAsk({ status: 'enabled', resolvedAt: T(9, 51), setup: setup(), setupError }))
  it('download failed (09): sentence from bytes + cause, Try again + Turn off browser', () => {
    const v = failed({ reason: 'download_failed', message: 'The Chromium download stopped at 840 MB (connection reset).', at: T(9, 53), bytes: 840e6, cause: 'connection reset' })
    assert.equal(text(v.title), "Couldn't turn on the browser for Primary")
    assert.equal(text(v.sub), "The Chromium download stopped at 840 MB (connection reset). snap_dashboard.py was stopped; nothing changed in Primary's tools.")
    assert.deepEqual([v.pill, v.tone], ['✕ Failed', 'bad'])
    assert.deepEqual(v.buttons.map((b) => [b.label, b.action, b.cls]), [['Try again', 'retry', 'primary'], ['Turn off browser', 'turnOff', 'ghost']])
    assert.equal(v.steps.length, 0)
    // no bytes: the BE message as is
    assert.equal(text(failed({ reason: 'download_failed', message: 'The download failed.', at: T(9, 53) }).sub).startsWith('The download failed. '), true)
  })
  it('check failed (09)', () => {
    const v = failed({ reason: 'chromium_check_failed', message: 'x', at: T(9, 57), cause: 'missing shared library', detail: 'libnss3.so missing' })
    assert.equal(text(v.title), "The browser isn't working for Primary")
    assert.equal(text(v.sub), "Chromium was installed but didn't start (missing shared library). Primary's previous tools were kept. Details in Settings › VM.")
    assert.deepEqual(v.buttons.map((b) => [b.label, b.action, b.cls]), [['Try again', 'retry', 'plain'], ['Open Settings › VM', 'settings', 'ghost']])
    assert.equal(v.pill, '✕ Check failed')
  })
  it('low disk (09): FE-7 sentences from the BrowserError figures; else the message', () => {
    const e = { reason: 'low_disk', message: 'server text', at: T(9, 59) }
    const v = failed({ ...e, neededBytes: 1343e6, freeBytes: 0.6 * 1024 ** 3 })
    assert.equal(text(v.title), 'Not enough space to turn on the browser')
    assert.equal(text(v.sub), 'The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.')
    assert.deepEqual([v.pill, v.buttons.map((b) => [b.label, b.cls])], ['✕ Low disk', [['Try again', 'plain']]])
    assert.equal(text(failed({ ...e, neededBytes: 1343e6, freeBytes: 2.5 * 1024 ** 3 }).sub), 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 2.5 GB free.')
    assert.equal(text(failed({ ...e, reused: true, freeBytes: 1 * 1024 ** 3 }).sub), LOW_DISK_TEXT)
    assert.equal(text(failed(e).sub), 'server text')
  })
  it('build failed (GAP): the message, Try again + Turn off', () => {
    const v = failed({ reason: 'build_failed', message: 'pip install playwright failed.', at: T(9, 55) })
    assert.equal(text(v.sub), 'pip install playwright failed.')
    assert.equal(v.buttons.length, 2)
  })
  it('after Turn off browser the buttons go (GAP); action errors show', () => {
    const e = { reason: 'download_failed', message: 'm', at: T(9, 53), bytes: 840e6 }
    assert.equal(view(brAsk({ status: 'enabled', setupError: e }), { turnedOff: true }).buttons.length, 0)
    assert.equal(view(brAsk({ status: 'enabled', setupError: e }), { actionError: 'boom' }).error, 'boom')
  })
  it('denied / expired / policy_changed (GAP)', () => {
    const d = view(brAsk({ status: 'denied', resolvedAt: T(9, 52), resolvedBy: 'user' }))
    assert.equal(text(d.title), 'Browser denied for snap_dashboard.py')
    assert.equal(text(d.sub), `You denied it at ${clockTime(T(9, 52))}. The browser stays off for Primary.`)
    assert.equal(text(view(brAsk({ status: 'timeout', resolvedAt: T(10, 0) })).title), 'Browser request expired')
    assert.equal(text(view(brAsk({ status: 'denied', closedBy: 'policy_changed', resolvedAt: T(9, 52) })).title), 'Browser request closed')
  })
  it('action errors: low_disk 409 uses the FE-7 sentence; others name the action', () => {
    const low = Object.assign(new Error('srv'), { status: 409, body: { statusCode: 409, error: 'Conflict', message: 'srv', reason: 'low_disk', neededBytes: 1343e6, freeBytes: 0.6 * 1024 ** 3 } })
    assert.equal(actionErrorText(low, 'retry'), 'The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.')
    const lowMsg = Object.assign(new Error('Not enough space.'), { status: 409, body: { reason: 'low_disk', message: 'Not enough space.' } })
    assert.equal(actionErrorText(lowMsg, 'retry'), 'Not enough space.')
    assert.equal(actionErrorText(Object.assign(new Error('Nothing to retry.'), { status: 409, body: { reason: 'nothing_to_retry' } }), 'retry'), "Couldn't try again: nothing to retry.")
    assert.equal(actionErrorText(new TypeError('Failed to fetch'), 'turnOff'), "Couldn't turn off the browser: could not reach the API server.")
  })
  it('the GAP list names every no-mockup state', () => {
    assert.deepEqual(Object.keys(PERMISSION_CARD_GAPS).sort(), ['actionError', 'browserDenied', 'browserExpired', 'buildFailed', 'closed', 'reusedDownload', 'rebuildDone', 'toolBuildPending', 'turnedOff', 'waitingIdle'].sort())
  })
})

describe('markup (mockup classes)', () => {
  it('pending: .pc group, icon, hosts, buttons, footer link, timer', () => {
    const out = html(view(netAsk()), { settingsHref: '?panel=settings&tab=vm' })
    assert.match(out, /^<div class="pc" role="group" aria-label="internet permission">/)
    assert.match(out, /<span class="pc-ico" aria-hidden="true">🌐<\/span>/)
    assert.match(out, /<p class="pc-s">To run <code>fetch_rates.py<\/code>: “/)
    assert.match(out, /<div class="pc-hosts"><span class="pc-hlbl">Expects to reach<\/span><span class="pc-host">api.frankfurter.app<\/span><\/div>/)
    assert.match(out, /<button type="button" class="btn btn--primary">Allow once<\/button><button type="button" class="btn">Always for Primary<\/button><button type="button" class="btn btn--ghost">Deny<\/button>/)
    assert.match(out, /<a href="\?panel=settings&amp;tab=vm">Settings › VM<\/a><\/span><span class="pc-timer">⏱ 9:41 left<\/span>/)
    // no href: the link is plain text
    assert.doesNotMatch(html(view(netAsk())), /<a /)
  })
  it('hosts are text, not markup (no IP arrows)', () => {
    const out = html(view(netAsk({ hosts: ['<b>x</b>'] })))
    assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/)
    assert.doesNotMatch(out, /→/)
  })
  it('sending: all buttons disabled, the sent one busy; error is an alert', () => {
    const out = html(view(netAsk(), { sendError: 'E' }), { busy: 'deny' })
    assert.equal((out.match(/disabled=""/g) ?? []).length, 3)
    assert.match(out, /aria-busy="true"><span class="spinner" aria-hidden="true"><\/span>Deny/)
    assert.match(out, /<p class="pc-err" role="alert">E<\/p><div class="pc-foot">/)
  })
  it('low timer class', () => {
    assert.match(html(view(netAsk(), { nowMs: ms(T(9, 49, 12)) })), /class="pc-timer pc-timer--low">⏱ 0:48 left/)
  })
  it('done: .pc--done, pill, bad border; steps, progress, next', () => {
    assert.match(html(view(netAsk({ status: 'denied', resolvedAt: T(9, 47) }))), /^<div class="pc pc--done pc--bad" role="group"[^>]*>.*<span class="pc-st pc-st--bad">✕ Denied<\/span><\/div><\/div>$/)
    const out = html(view(brAsk({ status: 'enabled', resolvedAt: T(9, 51), setup: setup() })))
    assert.match(out, /<ul class="pc-steps"><li><span class="i i--ok" aria-hidden="true">✓<\/span><span>Turned on for Primary by you<\/span>/)
    assert.match(out, /<li class="dim"><span class="i" aria-hidden="true">○<\/span><span>Rebuild Primary&#x27;s tools on the browser base<\/span><span class="m"><\/span><\/li>/)
    assert.match(out, /<div class="pc-prog" role="progressbar"[^>]*aria-valuenow="46"><span style="width:46%"><\/span><\/div>/)
    assert.match(out, /<div class="pc-next">Next: Primary asks for the internet, because the page is online.<\/div>/)
    assert.match(out, /<span class="pc-ico" aria-hidden="true">🧭<\/span>/)
  })
  it('error card buttons', () => {
    const out = html(view(brAsk({ status: 'enabled', setupError: { reason: 'low_disk', message: 'm', at: T(9, 59) } })))
    assert.match(out, /<div class="pc-btns"><button type="button" class="btn">Try again<\/button><\/div>/)
  })
})

describe('live store (fec4670)', () => {
  const apply = (s, ...a) => a.reduce(liveReducer, s)
  it('pending carries the clock skew; permissions put never reopens a resolved request', () => {
    let s = apply(initialLiveState, { type: 'pending', requests: [permission('p1')], skewMs: 1500 })
    assert.equal(s.clockSkewMs, 1500)
    s = apply(s, { type: 'pending', requests: [permission('p1')] })
    assert.equal(s.clockSkewMs, 1500)
    s = apply(s, { type: 'permissions', requests: [permission('p1', { status: 'denied' })] })
    assert.equal(permissionFor(s, 'p1').status, 'denied')
    const same = apply(s, { type: 'permissions', requests: [permission('p1')] })
    assert.equal(same, s)
    assert.equal(permissionFor(s, undefined), undefined)
  })
  it('permission.updated replaces a resolved request (new setup); browser.updated stores the download', () => {
    let s = apply(initialLiveState, { type: 'permissions', requests: [permission('b1', { type: 'browser', status: 'enabled' })] })
    const req = permission('b1', { type: 'browser', status: 'enabled', setup: setup() })
    s = apply(s, { type: 'event', event: { type: 'permission.updated', conversationId: 'c1', request: req } })
    assert.equal(s.permissions.b1.setup.download.bytes, 620e6)
    const browser = { state: 'downloading', bytes: 1, totalBytes: 2, usedBy: [] }
    s = apply(s, { type: 'event', event: { type: 'browser.updated', browser } })
    assert.deepEqual(s.browser, browser)
    s = apply(s, { type: 'browser', browser: { ...browser, state: 'ready' } })
    assert.equal(s.browser.state, 'ready')
  })
  it('a late requested never reopens; resolved still replaces', () => {
    let s = apply(initialLiveState, { type: 'event', event: { type: 'permission.resolved', conversationId: 'c1', request: permission('p1', { status: 'always' }) } })
    s = apply(s, { type: 'event', event: { type: 'permission.requested', conversationId: 'c1', request: permission('p1') } })
    assert.equal(s.permissions.p1.status, 'always')
    assert.deepEqual(pendingPermissions(s), [])
  })
  it('a run grant without requestId (policy Always) leaves cards alone', () => {
    let s = apply(initialLiveState, { type: 'pending', requests: [permission('p1')] })
    const r = run('r1', { permissions: [{ type: 'internet', decision: 'always' }] })
    s = apply(s, { type: 'run', run: r })
    assert.equal(s.permissions.p1.status, 'pending')
  })
})

describe('live events (fec4670)', () => {
  it('permission.updated and browser.updated are read; bad ones dropped', () => {
    const req = permission('b1', { type: 'browser', status: 'enabled' })
    const ev = { type: 'permission.updated', conversationId: 'c1', request: req }
    assert.deepEqual(readLiveFrame({ id: '7', event: 'permission.updated', data: JSON.stringify(ev) }), { kind: 'event', id: '7', event: ev })
    const b = { type: 'browser.updated', browser: { state: 'downloading', totalBytes: 1, usedBy: [] } }
    assert.equal(readLiveFrame({ event: 'browser.updated', data: JSON.stringify(b) }).kind, 'event')
    assert.equal(readLiveFrame({ event: 'browser.updated', data: JSON.stringify({ type: 'browser.updated', browser: {} }) }), null)
    assert.equal(readLiveFrame({ event: 'permission.updated', data: JSON.stringify({ type: 'permission.updated', request: {} }) }), null)
  })
})

describe('vm api (fec4670)', () => {
  function recorder() {
    const calls = []
    const request = async (path, init) => {
      calls.push([init?.method ?? 'GET', path, init?.body === undefined ? undefined : JSON.parse(init.body)])
      return {}
    }
    return { api: createVmApi(request, async () => ''), calls }
  }
  it('getPermission, getBrowser, retryBrowser', async () => {
    const { api, calls } = recorder()
    await api.getPermission('p/1')
    await api.getBrowser()
    await api.retryBrowser('a1')
    await api.retryBrowser()
    assert.deepEqual(calls, [
      ['GET', '/api/permissions/p%2F1', undefined],
      ['GET', '/api/vm/browser', undefined],
      ['POST', '/api/vm/browser/retry', { agentId: 'a1' }],
      ['POST', '/api/vm/browser/retry', {}],
    ])
    assert.equal(vmPaths.browserRetry(), '/api/vm/browser/retry')
  })
  it('409 already_resolved hands back the body request', () => {
    const req = permission('p1', { status: 'denied' })
    const err = Object.assign(new Error('Already answered.'), { status: 409, body: { statusCode: 409, error: 'Conflict', message: 'Already answered.', reason: 'already_resolved', request: req } })
    assert.deepEqual(permissionErrorOf(err), { kind: 'resolved', message: 'Already answered.', request: req })
    const bare = Object.assign(new Error('Already answered.'), { status: 409, body: { request: { nope: 1 } } })
    assert.deepEqual(permissionErrorOf(bare), { kind: 'resolved', message: 'Already answered.' })
  })
})

describe('live controller (fec4670)', () => {
  it('loadPermission fetches once per id and stores it', async () => {
    let n = 0
    const live = createLiveController({
      connection: {},
      client: {
        getRun: async () => run('r1'), getVm: async () => ({}), listPendingPermissions: async () => ({ requests: [] }),
        getPermission: async (id) => {
          n += 1
          return permission(id, { status: 'denied' })
        },
      },
    })
    const [a, b] = await Promise.all([live.loadPermission('p9'), live.loadPermission('p9')])
    assert.equal(n, 1)
    assert.equal(a.status, 'denied')
    assert.equal(b, a)
    assert.equal(live.getState().permissions.p9.status, 'denied')
    live.stop?.()
  })
  it('the pending list sets the skew from `now`, and resync re-fetches the browser', async () => {
    let browserCalls = 0
    const live = createLiveController({
      connection: {},
      now: () => Date.parse('2026-10-30T15:00:00.000Z'),
      client: {
        getRun: async () => run('r1'), getVm: async () => ({}),
        listPendingPermissions: async () => ({ requests: [permission('p1')], now: '2026-10-30T15:00:02.000Z' }),
        getBrowser: async () => {
          browserCalls += 1
          return { state: 'absent', totalBytes: 1343e6, usedBy: [] }
        },
      },
    })
    await live.resync()
    assert.equal(live.getState().clockSkewMs, 2000)
    assert.equal(browserCalls, 1)
    assert.equal(live.getState().browser.state, 'absent')
    live.stop?.()
  })
})

describe('"after the current run": the VM fetch for a browser setup in progress', () => {
  const setup = (o = {}) => ({
    turnedOnAt: T(9, 51), turnedOnBy: 'user', requestId: 'pb', runId: 'run_snap',
    download: { startedAt: T(9, 51), endedAt: T(9, 52, 42), totalBytes: 1343e6 },
    rebuild: { startedAt: T(9, 52, 50), endedAt: T(9, 53, 42) }, check: { status: 'pending' }, ...o,
  })
  const enabled = (o = {}) => ({
    ...permission('pb', { type: 'browser', agentId: 'ag_primary', hosts: undefined, scriptName: 'snap_dashboard.py' }),
    status: 'enabled', resolvedAt: T(9, 51), resolvedBy: 'user', setup: setup(), ...o,
  })
  it('setupVmAgent: a setup in progress needs the bot\'s VM until it is held', () => {
    assert.equal(setupVmAgent(enabled(), {}), 'ag_primary')
    assert.equal(setupVmAgent(enabled({ setup: undefined }), {}), 'ag_primary') // just enabled, no setup copy yet
    assert.equal(setupVmAgent(enabled(), { ag_primary: {} }), undefined)
  })
  it('setupVmAgent: nothing to fetch when ready, failed, unanswered, denied, internet, or unloaded', () => {
    assert.equal(setupVmAgent(enabled({ setup: setup({ readyAt: T(9, 54), check: { status: 'pass', at: T(9, 54) } }) }), {}), undefined)
    assert.equal(setupVmAgent(enabled({ setupError: { reason: 'download_failed', message: 'x', at: T(9, 53) } }), {}), undefined)
    assert.equal(setupVmAgent(enabled({ status: 'pending' }), {}), undefined)
    assert.equal(setupVmAgent(enabled({ status: 'denied' }), {}), undefined)
    assert.equal(setupVmAgent(enabled({ type: 'internet' }), {}), undefined)
    assert.equal(setupVmAgent(undefined, {}), undefined)
  })
  it('the card\'s fetch (loadVm) stores waiting_idle, and the check step then says "after the current run"', async () => {
    const asked = []
    const live = createLiveController({
      connection: {},
      client: {
        getRun: async () => run('r1'), listPendingPermissions: async () => ({ requests: [] }),
        getVm: async (id) => {
          asked.push(id)
          return { agentId: id, browser: { state: 'waiting_idle' } }
        },
      },
    })
    const request = enabled()
    const stepOf = () => {
      const st = live.getState()
      const v = permissionCardView({ request, botName: 'Primary', nowMs: ms(T(9, 54, 30)), botBrowserState: st.vms[request.agentId]?.browser?.state })
      return v.steps.find((s) => s.key === 'ck')
    }
    // before: the restart step runs with no meta
    assert.deepEqual([stepOf().state, stepOf().meta], ['run', undefined])
    const agent = setupVmAgent(request, live.getState().vms)
    assert.equal(agent, 'ag_primary')
    await live.loadVm(agent)
    assert.deepEqual(asked, ['ag_primary'])
    assert.equal(setupVmAgent(request, live.getState().vms), undefined) // held now: no second fetch
    assert.equal(stepOf().label, "Restarting Primary's VM and checking Chromium")
    assert.equal(stepOf().meta, 'after the current run')
    live.stop?.()
  })
})
