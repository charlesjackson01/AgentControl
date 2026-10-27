// FE-P2-2: run card logic (src/lib/run-card.ts) and markup (src/lib/run-card-render.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  clockText, commandLine, durationText, memoryText, outputErrorText, runCardLabel, runCardView, runtimeLabel, statusText, statusTone,
  stopErrorText, tailLines, undoUnavailableText, FILES_SHOWN, RUN_CARD_GAPS,
} from '../src/lib/run-card.ts'
import { renderRunCard } from '../src/lib/run-card-render.ts'
import { UNDO_UNAVAILABLE_REASONS } from '../src/lib/types.ts'
import { undoGoneText } from '../src/lib/undo.ts'
import { run, summary } from './live-fixtures.mjs'

const GB = 1024 ** 3
const T0 = Date.parse('2026-10-27T17:31:00.000Z')
const at = (ms) => new Date(T0 + ms).toISOString()

// Mockup (a), card 1.
const cleanSales = run('r42', {
  argv: ['python', 'skills/csv-tools/clean_sales.py', 'workspace/sales.csv'],
  skillId: 'csv-tools',
  status: 'succeeded', exitCode: 0, startedAt: at(0), endedAt: at(4200), durationMs: 4200, peakMemoryMb: 212,
  snapshot: { id: 'run-0042', driver: 'reflink', retainedBytes: 300_000 },
  stdoutTail: 'read 2,418 rows · dropped 37 duplicates · fixed 12 dates\nwrote workspace/sales.clean.csv (2,381 rows)\n',
  filesChanged: [
    { path: 'workspace/sales.clean.csv', change: 'added', bytes: 151_552 },
    { path: 'workspace/sales.csv', change: 'modified', bytes: 154_624 },
  ],
})
const cleanSummary = summary({ status: 'succeeded', name: 'csv-tools', files: { added: 1, modified: 1, deleted: 0 }, exitCode: 0 })
// Card 2.
const chartFail = run('r43', {
  argv: ['python', 'workspace/chart_revenue.py', 'workspace/sales.clean.csv'],
  status: 'failed', exitCode: 1, startedAt: at(0), durationMs: 1100,
  stderrTail: "Traceback (most recent call last):\n  File \"/bot/workspace/chart_revenue.py\", line 3, in <module>\n    import matplotlib.pyplot as plt\nModuleNotFoundError: No module named 'matplotlib'\n",
})
// Card 3.
const chartRun = run('r44', {
  argv: ['sh', '-c', 'pip install --user matplotlib && python workspace/chart_revenue.py workspace/sales.clean.csv'],
  status: 'running', startedAt: at(0), network: 'on',
  permissions: [{ requestId: 'p1', type: 'internet', decision: 'allow_once' }],
})
const view = (r, extra = {}) => runCardView({ run: r, now: T0 + 7000, ...extra })
const html = (v, x) => renderToStaticMarkup(h('div', null, renderRunCard(v, x)))

describe('formatting', () => {
  it('durations, clocks, memory, runtime', () => {
    assert.equal(durationText(4200), '4.2 s')
    assert.equal(durationText(1100), '1.1 s')
    assert.equal(durationText(38_000), '38 s')
    assert.equal(durationText(125_000), '2 min 5 s')
    assert.equal(durationText(600_000), '10 min')
    assert.equal(durationText(undefined), null)
    assert.equal(durationText(-1), null)
    assert.equal(clockText(7000), '0:07')
    assert.equal(clockText(760_000), '12:40')
    assert.equal(clockText(3_723_000), '1:02:03')
    assert.equal(clockText(-5), '0:00')
    assert.equal(memoryText(212), '212 MB')
    assert.equal(memoryText(4096), '4 GB')
    assert.equal(memoryText(1536), '1.5 GB')
    assert.equal(runtimeLabel('runsc'), 'gVisor')
    assert.equal(runtimeLabel('crun'), 'standard runtime')
    assert.equal(runtimeLabel('runc'), 'standard runtime')
    assert.equal(runtimeLabel(null), null)
  })
  it('quotes argv only where needed', () => {
    assert.equal(commandLine(['python', 'skills/x.py', 'workspace/sales.csv']), 'python skills/x.py workspace/sales.csv')
    assert.equal(commandLine(['sh', '-c', 'a && b']), "sh -c 'a && b'")
    assert.equal(commandLine(['echo', "it's", '']), "echo 'it'\\''s' ''")
  })
  it('keeps the last lines', () => {
    assert.equal(tailLines('1\n2\n3\n4\n5\n6\n7\n8\n\n', 3), '6\n7\n8')
  })
})

describe('status pill', () => {
  it('mockup (a) wording', () => {
    assert.equal(statusText('succeeded', { durationMs: 4200 }), 'Succeeded · 4.2 s')
    assert.equal(statusText('failed', { exitCode: 1, durationMs: 1100 }), 'Failed · exit 1 · 1.1 s')
    assert.equal(statusText('running', { elapsedMs: 7000 }), 'Running · 0:07')
    assert.equal(statusText('running', { elapsedMs: 7000 }, false), 'Running')
  })
  it('GAP states', () => {
    assert.equal(statusText('queued', { queuePosition: 2 }), 'Queued · 2 ahead')
    assert.equal(statusText('queued', { queuePosition: 0 }), 'Queued · next')
    assert.equal(statusText('queued', {}), 'Queued')
    assert.equal(statusText('timed_out', { durationMs: 600_000 }), 'Timed out · 10 min')
    assert.equal(statusText('stopped', { durationMs: 3200 }), 'Stopped · 3.2 s')
    assert.equal(statusText('denied', {}), 'Denied')
    assert.equal(statusText('undone', {}), 'Undone')
    assert.equal(statusText('waiting_permission', {}), 'Waiting for permission')
  })
  it('tones', () => {
    assert.deepEqual(
      ['succeeded', 'failed', 'timed_out', 'denied', 'running', 'queued', 'stopped', 'undone'].map(statusTone),
      ['ok', 'bad', 'bad', 'bad', 'run', 'run', 'undone', 'undone'],
    )
  })
})

describe('runCardView: mockup (a)', () => {
  it('succeeded card', () => {
    const v = view(cleanSales, { summary: cleanSummary })
    assert.equal(v.pill, 'Script')
    assert.equal(v.name, 'clean_sales.py')
    assert.equal(v.source, 'csv-tools')
    assert.equal(v.statusText, 'Succeeded · 4.2 s')
    assert.equal(v.tone, 'ok')
    assert.equal(v.bad, false)
    assert.equal(v.command, '$ python skills/csv-tools/clean_sales.py workspace/sales.csv')
    assert.deepEqual(v.meta.map((m) => `${m.label} ${m.value}${m.suffix ? ` ${m.suffix}` : ''}`), [
      'Exit 0', 'Internet off', 'Peak memory 212 MB of 4 GB', 'Snapshot run-0042', 'Runtime gVisor',
    ])
    assert.deepEqual(v.files.map((f) => [f.change, f.path, f.size]), [
      ['added', 'workspace/sales.clean.csv', '148 KB'],
      ['modified', 'workspace/sales.csv', '151 KB'],
    ])
    assert.equal(v.log.text, 'read 2,418 rows · dropped 37 duplicates · fixed 12 dates\nwrote workspace/sales.clean.csv (2,381 rows)')
    assert.deepEqual(v.actions, { stop: false, undo: true, output: true })
    assert.equal(v.note, 'Undo restores the 2 files above')
    assert.equal(v.noteFirst, false)
  })
  it('failed card: red, no meta line, traceback in the error log, nothing to undo', () => {
    const v = view(chartFail)
    assert.equal(v.statusText, 'Failed · exit 1 · 1.1 s')
    assert.equal(v.bad, true)
    assert.equal(v.source, 'workspace')
    assert.deepEqual(v.meta, [])
    assert.equal(v.log.error, true)
    assert.match(v.log.text, /^Traceback[\s\S]*\n {2}File [\s\S]*\nModuleNotFoundError/)
    assert.deepEqual(v.actions, { stop: false, undo: false, output: true })
    assert.equal(v.note, 'No files changed · nothing to undo')
    assert.equal(v.noteFirst, true)
  })
  it('running card: clock, spinner, bar, live log, Stop, internet + limit note', () => {
    const v = view(chartRun, { output: { stdout: 'Collecting matplotlib\nInstalling collected packages: matplotlib', stderr: '' } })
    assert.equal(v.statusText, 'Running · 0:07')
    assert.equal(v.statusLabel, 'Running')
    assert.equal(v.spinner, true)
    assert.equal(v.progress, true)
    assert.equal(v.log.live, true)
    assert.deepEqual(v.actions, { stop: true, undo: false, output: false })
    assert.equal(v.note, 'Internet on (allowed once) · limit 10 min')
    assert.deepEqual(v.files, [])
    assert.deepEqual(v.meta, [])
  })
  it('M1: an internet run fails and says so', () => {
    const v = view(run('r9', { status: 'failed', network: 'on', durationMs: 300, error: "Internet access isn't available yet." }))
    assert.equal(v.log.text, "Internet access isn't available yet.")
    assert.equal(v.log.error, true)
    assert.equal(v.error, null)
  })
  it('stderr and an error: the error goes on its own line', () => {
    const v = view(run('r9', { status: 'failed', stderrTail: 'boom', error: 'Out of memory' }))
    assert.equal(v.log.text, 'boom')
    assert.equal(v.error, 'Out of memory')
  })
})

describe('runCardView: GAP states', () => {
  it('queued shows its place in line', () => {
    const v = view(run('q', { status: 'queued', queuePosition: 1 }))
    assert.equal(v.statusText, 'Queued · 1 ahead')
    assert.equal(v.actions.stop, true)
    assert.equal(v.progress, false)
    assert.equal(v.note, 'Starts when the machine is free · limit 10 min')
  })
  it('timed out keeps its files and can be undone', () => {
    const v = view(run('t', { status: 'timed_out', durationMs: 600_000, error: 'Stopped at the 10 min limit.', filesChanged: [{ path: 'workspace/a.csv', change: 'modified', bytes: 10 }] }))
    assert.equal(v.statusText, 'Timed out · 10 min')
    assert.equal(v.bad, true)
    assert.equal(v.actions.undo, true)
    assert.equal(v.note, 'Undo restores the file above')
  })
  it('stopped is grey, with the meta line', () => {
    const v = view(run('s', { status: 'stopped', durationMs: 3200, exitCode: 143, runtime: 'crun' }))
    assert.equal(v.tone, 'undone')
    assert.equal(v.bad, false)
    assert.equal(v.meta.at(-1).value, 'standard runtime')
  })
  it('undone: by status or by undo.state done', () => {
    const a = view(run('u', { status: 'undone', undo: { state: 'done', at: '2026-10-27T19:10:00.000Z', undoRunId: 'x' } }))
    const b = view(run('u', { status: 'succeeded', undo: { state: 'done' } }))
    assert.equal(a.statusText, 'Undone')
    assert.match(a.note, /^Undone at \d{1,2}:10 (AM|PM)$/)
    assert.equal(b.status, 'undone')
    assert.equal(b.note, 'Undone')
    assert.equal(b.actions.undo, false)
  })
  it('every undo reason: the §7.4 line in place of the button', () => {
    for (const reason of UNDO_UNAVAILABLE_REASONS) {
      const v = view(cleanSales, { botName: 'Analyst', budgetBytes: 2 * GB, run: { ...cleanSales, undo: { state: 'unavailable', reason } } })
      assert.equal(v.actions.undo, false, reason)
      assert.equal(v.noteFirst, true)
      if (reason === 'too_large') assert.equal(v.note, "Undo isn't available for this run: it changed more than the undo space.")
      else assert.equal(v.note, undoGoneText(reason, { botName: 'Analyst', budgetBytes: 2 * GB }))
    }
    assert.equal(
      undoUnavailableText({ state: 'unavailable', reason: 'budget_bot' }, { botName: 'Analyst', budgetBytes: 2 * GB }),
      "Undo no longer available: removed to stay within Analyst's 2 GB undo space.",
    )
    assert.equal(undoUnavailableText({ state: 'unavailable', reason: 'expired' }, {}), 'Undo no longer available: older than 7 days and not in the last 20 runs.')
    assert.equal(undoUnavailableText({ state: 'available' }, {}), null)
  })
  it('tool build: own pill, no Undo', () => {
    const v = view(run('tb', { kind: 'tool_build', argv: ['apt-get', 'install', '-y', 'ffmpeg'], status: 'succeeded', filesChanged: [{ path: 'tools/x', change: 'added', bytes: 1 }] }))
    assert.equal(v.pill, 'Tool build')
    assert.equal(v.pillIcon, '⚙')
    assert.equal(v.source, null)
    assert.equal(v.actions.undo, false)
    assert.equal(v.note, "Undo doesn't cover installed tools")
  })
  it('undo-of-a-run card names the run it undid, and can itself be undone', () => {
    const v = view(run('ur', { kind: 'undo', argv: [], undoOfRunId: 'r42', status: 'succeeded', filesChanged: [{ path: 'workspace/sales.clean.csv', change: 'deleted' }] }), { undoOfName: 'clean_sales.py' })
    assert.equal(v.pill, 'Undo')
    assert.equal(v.name, 'Undo of clean_sales.py')
    assert.equal(v.files[0].size, null)
    assert.equal(v.actions.undo, true)
    assert.equal(view(run('ur', { kind: 'undo', argv: [] })).name, 'Undo of a run')
  })
  it('collapsed undo card titles from summary.undoOfName (BE be7afe4), else the old text', () => {
    const s = summary({ kind: 'undo', status: 'succeeded', name: 'undo', undoOfName: 'export_report.py' })
    const v = runCardView({ summary: s })
    assert.equal(v.loading, true, 'collapsed: no run fetched')
    assert.equal(v.name, 'Undo of export_report.py')
    assert.equal(runCardView({ summary: s, undoOfName: 'other.py' }).name, 'Undo of export_report.py', 'the summary wins')
    assert.equal(runCardView({ summary: { ...s, undoOfName: undefined } }).name, 'Undo of a run')
    assert.equal(view(run('ur', { kind: 'undo', argv: [] }), { summary: s }).name, 'Undo of export_report.py', 'expanded reads the same as collapsed')
    assert.equal(runCardView({ summary: { ...s, undoOfName: undefined }, undoOfName: 'clean_sales.py' }).name, 'Undo of clean_sales.py')
  })
  it('too-large output', () => {
    assert.equal(view(run('o', { status: 'succeeded', outputTruncated: true })).truncated, "Output passed the 200 MB limit; the rest wasn't kept.")
    assert.equal(view(cleanSales).truncated, null)
  })
  it('caps the file list', () => {
    const files = Array.from({ length: FILES_SHOWN + 3 }, (_, i) => ({ path: `shared/f${i}.txt`, change: 'added', bytes: 1, root: 'group', groupId: 'g1' }))
    const v = view(run('f', { status: 'succeeded', filesChanged: files }))
    assert.equal(v.files.length, FILES_SHOWN)
    assert.equal(v.moreFiles, 3)
    assert.equal(v.files[0].path, 'shared/f0.txt')
    assert.equal(v.files[0].folder, 'group folder')
    assert.equal(v.note, `Undo restores the ${FILES_SHOWN + 3} files above`)
  })
  it('summary only (details loading): head from the summary', () => {
    const v = runCardView({ summary: summary({ status: 'succeeded', name: 'clean.py' }) })
    assert.equal(v.loading, true)
    assert.equal(v.name, 'clean.py')
    assert.equal(v.statusText, 'Succeeded')
    assert.deepEqual(v.actions, { stop: false, undo: false, output: false })
  })
  it('a live summary update wins over a stale message summary only through the run', () => {
    const v = view({ ...cleanSales, status: 'running', startedAt: at(0) }, { summary: cleanSummary })
    assert.equal(v.status, 'running')
  })
})

describe('copy for errors', () => {
  it('stop: 409 is silent, others say why', () => {
    assert.equal(stopErrorText(Object.assign(new Error('x'), { status: 409 })), null)
    assert.equal(stopErrorText(Object.assign(new Error('Busy'), { status: 500 })), "Couldn't stop the run: Busy")
    assert.equal(stopErrorText(new TypeError('Failed to fetch')), "Couldn't stop the run: could not reach the API server.")
  })
  it('full output: evicted vs failed', () => {
    assert.match(outputErrorText({ status: 410 }), /removed to free space/)
    assert.match(outputErrorText({ status: 404 }), /removed to free space/)
    assert.equal(outputErrorText({ status: 500 }), "Couldn't load the full output.")
  })
})

describe('renderRunCard', () => {
  it('succeeded card markup (mockup a)', () => {
    const out = html(view(cleanSales, { summary: cleanSummary }), { open: true, onToggle: () => {}, bodyId: 'b1' })
    assert.match(out, /<button type="button" class="rc-head" aria-expanded="true" aria-controls="b1"/)
    assert.match(out, /class="rc-name">clean_sales.py</)
    assert.match(out, /class="rc-src">csv-tools</)
    assert.match(out, /class="rc-st rc-st--ok"><span class="rc-dot" aria-hidden="true"><\/span><span>Succeeded · 4.2 s<\/span>/)
    assert.match(out, /class="rc-cmd">\$ python skills\/csv-tools\/clean_sales.py workspace\/sales.csv</)
    assert.match(out, /<span>Peak memory <b>212 MB<\/b> of 4 GB<\/span>/)
    assert.match(out, /<span>Runtime <b>gVisor<\/b><\/span>/)
    assert.match(out, /class="rc-chg rc-chg--add">added<\/span><span class="rc-path">workspace\/sales.clean.csv<\/span><span class="rc-size">148 KB/)
    assert.match(out, /↶ Undo run<\/button><button type="button" class="btn btn--ghost rc-btn">Full output<\/button><span class="rc-sp"><\/span><span class="rc-note">Undo restores the 2 files above/)
    assert.match(out, /role="group" aria-label="Script run clean_sales.py: Succeeded · 4.2 s"/)
  })
  it('failed card markup: red border, error log, note first', () => {
    const out = html(view(chartFail))
    assert.match(out, /class="rc rc--bad"/)
    assert.match(out, /class="rc-log rc-log--err"/)
    assert.match(out, /&lt;module&gt;/)
    assert.match(out, /rc-acts rc-acts--note-first"><span class="rc-note">No files changed · nothing to undo<\/span><span class="rc-sp"><\/span><button[^>]*>Full output/)
    assert.doesNotMatch(out, /rc-meta/)
  })
  it('running card markup: spinner, bar, caret, Stop, sr-only status', () => {
    const out = html(view(chartRun, { output: { stdout: 'Collecting', stderr: '' } }), { stopping: false, onStop: () => {} })
    assert.match(out, /class="rc-spin"/)
    assert.match(out, /class="rc-bar" aria-hidden="true"><span><\/span>/)
    assert.match(out, /rc-log rc-log--live/)
    assert.match(out, /rc-caret/)
    assert.match(out, /<span aria-hidden="true">Running · 0:07<\/span><span class="sr-only">Running<\/span>/)
    assert.match(out, />■ Stop<\/button>/)
    assert.match(html(view(chartRun), { stopping: true, onStop: () => {} }), /disabled="">Stopping…/)
    assert.match(html(view(chartRun), { stopError: 'Nope' }), /role="alert">Nope/)
  })
  it('collapsed hides the body', () => {
    const out = html(view(cleanSales), { open: false, onToggle: () => {}, bodyId: 'b' })
    assert.match(out, /aria-expanded="false"/)
    assert.match(out, /class="rc-body" id="b" hidden=""/)
    assert.match(out, /class="rc-chev" aria-hidden="true">▸/)
  })
  it('loading and load error', () => {
    const v = runCardView({ summary: summary({ status: 'running' }) })
    assert.match(html(v), /rc-skel/)
    assert.match(html(v), /■ Stop/)
    const err = html(v, { loadError: "Couldn't load this run's details.", onRetry: () => {} })
    assert.match(err, /role="alert">Couldn&#x27;t load this run&#x27;s details. <button[^>]*>Retry/)
  })
  it('unavailable undo, truncated output, more files', () => {
    const out = html(view({ ...cleanSales, outputTruncated: true, undo: { state: 'unavailable', reason: 'expired' } }))
    assert.match(out, /Undo no longer available: older than 7 days and not in the last 20 runs./)
    assert.doesNotMatch(out, /Undo run/)
    assert.match(out, /class="rc-trunc"/)
    const many = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}`, change: 'modified', bytes: 1 }))
    assert.match(html(view(run('m', { status: 'succeeded', filesChanged: many }))), /class="rc-more">\+ 2 more files/)
  })
  it('label', () => {
    assert.equal(runCardLabel({ pill: 'Script', name: 'a.py', statusLabel: 'Running' }), 'Script run a.py: Running')
  })
  it('lists its GAPs', () => {
    assert.ok(Object.keys(RUN_CARD_GAPS).length >= 12)
  })
})

describe('wiring', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
  it('DM and group chats render run messages as bare run cards', () => {
    for (const page of ['../src/pages/ConversationChat.tsx', '../src/pages/GroupChat.tsx']) {
      const src = read(page)
      assert.match(src, /m\.kind === 'run' && m\.scriptRunId/)
      assert.match(src, /<RunCard message=\{m\}/)
      assert.match(src, / bare>/)
    }
  })
  it('the card updates from the live store by messageId and saves undo results', () => {
    const src = read('../src/components/chat/RunCard.tsx')
    assert.match(src, /runSummaryFor\(state, message\)/)
    assert.match(src, /state\.runs\[runId\]/)
    assert.match(src, /putRun\(result\.run\)\s+putRun\(result\.undoRun\)/)
    assert.match(src, /<UndoDialog/)
    assert.match(src, /client\.stopRun\(runId\)/)
  })
})

describe('BE 146cd18: summary fields, file scopes, too_large bytes', () => {
  it('a collapsed card renders from the summary alone (scriptName, durationMs)', () => {
    const v = runCardView({ summary: { status: 'failed', kind: 'script', name: 'csv-tools', scriptName: 'clean_sales.py', durationMs: 1100, exitCode: 1, files: { added: 0, modified: 0, deleted: 0 }, undo: { state: 'available' } } })
    assert.equal(v.name, 'clean_sales.py')
    assert.equal(v.source, 'csv-tools')
    assert.equal(v.statusText, 'Failed · exit 1 · 1.1 s')
    assert.equal(v.loading, true)
  })
  it('no scriptName (older messages): the summary name', () => {
    assert.equal(runCardView({ summary: { status: 'succeeded', kind: 'script', name: 'report.py', files: { added: 0, modified: 0, deleted: 0 }, undo: { state: 'available' } } }).name, 'report.py')
  })
  it('paths are shown as is (no "group:" stripping); root group names the folder', () => {
    const v = runCardView({ run: run('g', { status: 'succeeded', filesChanged: [
      { path: 'group:odd.txt', change: 'added', bytes: 1 },
      { path: 'shared/plan.md', change: 'modified', bytes: 1, root: 'group', groupId: 'g1', groupName: 'TL-1 Launch Room' },
      { path: 'shared/b.md', change: 'modified', bytes: 1, root: 'group', groupId: 'g2' },
      { path: 'workspace/a.csv', change: 'modified', bytes: 1, root: 'agent' },
    ] }), groupNames: { g2: 'Research' } })
    assert.deepEqual(v.files.map((f) => [f.path, f.folder]), [['group:odd.txt', null], ['shared/plan.md', 'TL-1 Launch Room group folder'], ['shared/b.md', 'Research group folder'], ['workspace/a.csv', null]])
    assert.match(renderToStaticMarkup(renderRunCard(v)), /<span class="rc-folder">TL-1 Launch Room group folder<\/span>/)
  })
  it('too_large uses undo.changedBytes', () => {
    const v = runCardView({ run: run('t', { status: 'succeeded', filesChanged: [{ path: 'a', change: 'added', bytes: 1 }], undo: { state: 'unavailable', reason: 'too_large', changedBytes: 6.2 * 1024 ** 3 } }) })
    assert.equal(v.note, "Undo isn't available for this run: it changed 6.2 GB, more than the undo space.")
  })
})

describe('sidebar preview of a run message', () => {
  it('content as is when there is any; else a minimal line from scriptRun', async () => {
    const { previewText, runPreview } = await import('../src/lib/conversations.ts')
    const m = (content, scriptRun) => ({ role: 'assistant', content, kind: 'run', scriptRun })
    assert.equal(previewText(m('Ran report.py', summary({ status: 'failed', scriptName: 'x.py' }))), 'Ran report.py')
    assert.equal(previewText(m('', summary({ status: 'succeeded', name: 'csv-tools', scriptName: 'report.py' }))), 'Ran report.py')
    assert.equal(previewText(m('', summary({ status: 'failed', name: 'report.py' }))), 'Ran report.py', 'minimal: no status words')
    assert.equal(previewText(m('Running report.py', summary({ status: 'running', name: 'report.py' }))), 'Running report.py')
    assert.equal(runPreview(undefined), 'Ran script')
    assert.equal(runPreview(summary({ status: 'queued', name: 'r.py' })), 'Ran r.py')
    assert.equal(runPreview(summary({ kind: 'undo', status: 'succeeded', name: 'r.py' })), 'Undo of r.py')
    assert.equal(runPreview(summary({ kind: 'undo', status: 'succeeded', name: 'undo', undoOfName: 'export_report.py' })), 'Undo of export_report.py')
    assert.equal(runPreview(summary({ kind: 'undo', status: 'succeeded', name: 'r.py', undoOfName: ' ' })), 'Undo of r.py')
    assert.equal(previewText({ role: 'assistant', content: '' }), '…', 'not a run: unchanged')
    const { previewLine } = await import('../src/lib/shell.ts')
    const last = { ...m('', summary({ status: 'succeeded', name: 'report.py' })), authorAgentId: 'a1' }
    assert.equal(previewLine({ kind: 'group', lastMessage: last }, [{ id: 'a1', name: 'Analyst' }]), 'Analyst: Ran report.py', 'group: author + run line')
  })
})

describe('RunCard fetches the full run only when needed (BE 3a70c34 summary fields)', () => {
  const src = readFileSync(new URL('../src/components/chat/RunCard.tsx', import.meta.url), 'utf8')
  it('loads on open (expand/details), and Undo / Full output load it first when missing', () => {
    assert.match(src, /if \(open && !haveRun\) load\(\)/)
    assert.match(src, /onUndo: \(\) => \{\s*if \(!run\) load\(\)\s*setDialog\('undo'\)/)
    assert.match(src, /onOutput: \(\) => \{\s*if \(!run\) load\(\)\s*setDialog\('output'\)/)
  })
})
