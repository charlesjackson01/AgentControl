// FE-P2-4: undo dialog logic (src/lib/undo.ts) and its body markup (src/lib/undo-render.ts).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  caveatText, conflictRows, initialUndoPhase, undoRowNote, runWhen, undoFooter, undoGoneText, undoReasonText, undoReducer, undoRows, undoSubtitle,
} from '../src/lib/undo.ts'
import { renderUndoBody } from '../src/lib/undo-render.ts'
import { UNDO_MACHINE_RESTORED_TEXT, UNDO_UNAVAILABLE_REASONS } from '../src/lib/types.ts'
import { undoErrorOf } from '../src/lib/vm-api.ts'
import { run } from './live-fixtures.mjs'

const GB = 1024 ** 3
// Mockup d: clean_sales.py added sales.clean.csv and modified sales.csv.
const preview = (extra = {}) => ({
  runId: 'r1',
  changes: [
    { path: 'workspace/sales.clean.csv', action: 'delete', root: 'agent' },
    { path: 'workspace/sales.csv', action: 'restore', root: 'agent' },
  ],
  conflicts: [],
  caveats: ['internet'],
  ...extra,
})
const cleanSales = run('r1', {
  argv: ['python', 'skills/csv-tools/clean_sales.py', 'workspace/sales.csv'],
  status: 'succeeded',
  filesChanged: [
    { path: 'workspace/sales.clean.csv', change: 'added', bytes: 151_000 },
    { path: 'workspace/sales.csv', change: 'modified', bytes: 158_000 },
  ],
})
const apiErr = (status, body, message = 'x') => Object.assign(new Error(message), { status, body })
const render = (phase, ctx) => renderToStaticMarkup(h('div', null, renderUndoBody(phase, ctx)))

describe('reason copy (§7.4)', () => {
  it('has text for every reason, in the plan wording', () => {
    assert.equal(undoReasonText('expired'), 'older than 7 days and not in the last 20 runs')
    assert.equal(undoReasonText('budget_bot', { botName: 'Analyst', budgetBytes: 2 * GB }), "removed to stay within Analyst's 2 GB undo space")
    assert.equal(undoReasonText('budget_bot'), "removed to stay within the bot's undo space")
    assert.equal(undoReasonText('budget_global'), 'removed to free disk space')
    assert.equal(undoReasonText('low_disk'), 'removed to free disk space')
    assert.equal(undoReasonText('too_large', { changedBytes: 6.2 * GB }), 'it changed 6.2 GB, more than the undo space')
    assert.equal(undoReasonText('too_large'), 'it changed more than the undo space')
    for (const r of UNDO_UNAVAILABLE_REASONS) assert.ok(undoReasonText(r).length > 10, r)
    assert.equal(undoGoneText('expired'), 'Undo no longer available: older than 7 days and not in the last 20 runs.')
  })
  it('caveats: internet (mockup d), tools, both, none', () => {
    assert.equal(caveatText(['internet']), "Undo changes files only; it can't take back anything a script sent over the internet.")
    assert.match(caveatText(['tools']), /tools a script installed/)
    assert.match(caveatText(['internet', 'tools']), /internet, or tools it installed/)
    assert.equal(caveatText([]), null)
  })
})

describe('subtitle', () => {
  const now = new Date(2026, 9, 27, 18, 0)
  it('"clean_sales.py · today 5:31 PM · Analyst"', () => {
    const r = { ...cleanSales, startedAt: new Date(2026, 9, 27, 17, 31).toISOString() }
    assert.equal(undoSubtitle(r, 'Analyst', now), 'clean_sales.py · today 5:31 PM · Analyst')
    assert.equal(undoSubtitle({ ...r, kind: 'tool_build' }, undefined, now), 'Tool build · today 5:31 PM')
  })
  it('yesterday, other days, other years, midnight and noon', () => {
    assert.equal(runWhen(new Date(2026, 9, 26, 0, 5).toISOString(), now), 'yesterday 12:05 AM')
    assert.equal(runWhen(new Date(2026, 9, 12, 12, 0).toISOString(), now), 'Oct 12, 12:00 PM')
    assert.equal(runWhen(new Date(2025, 0, 2, 9, 7).toISOString(), now), 'Jan 2, 2025, 9:07 AM')
    assert.equal(runWhen('nope', now), null)
    assert.equal(runWhen(undefined, now), null)
  })
})

describe('rows', () => {
  it('delete = added by this run; restore = modified / deleted by this run (mockup d)', () => {
    const rows = undoRows(preview({ changes: [...preview().changes, { path: 'workspace/old.csv', action: 'restore', root: 'agent' }] }), {
      filesChanged: [...cleanSales.filesChanged, { path: 'workspace/old.csv', change: 'deleted' }],
    })
    assert.deepEqual(rows.map((r) => [r.action, r.path, r.note, r.folder]), [
      ['delete', 'workspace/sales.clean.csv', 'added by this run', null],
      ['restore', 'workspace/sales.csv', 'modified by this run', null],
      ['restore', 'workspace/old.csv', 'deleted by this run', null],
    ])
  })
  it('group rows name the group folder (§7.3.5); the run record matches by root + groupId, not a "group:" prefix', () => {
    const p = preview({ changes: [{ path: 'shared/pier.md', action: 'restore', root: 'group', groupId: 'g1' }, { path: 'x.md', action: 'delete', root: 'group', groupId: 'g9' }] })
    const rows = undoRows(p, { filesChanged: [{ path: 'shared/pier.md', change: 'deleted', root: 'group', groupId: 'g1' }] }, { groupNames: { g1: 'TL-1 Launch Room' } })
    assert.equal(undoRows(p, { filesChanged: [{ path: 'group:shared/pier.md', change: 'deleted' }] })[0].note, 'modified by this run', 'no prefix fallback')
    assert.equal(undoRows(p, { filesChanged: [{ path: 'shared/pier.md', change: 'deleted' }] })[0].note, 'modified by this run', 'workspace file of the same path is another file')
    assert.deepEqual(rows.map((r) => [r.note, r.folder]), [['deleted by this run', 'TL-1 Launch Room group folder'], ['added by this run', 'group folder']])
    assert.deepEqual(conflictRows([{ path: 'a', root: 'agent' }, { path: 'b', root: 'group', groupId: 'g1' }], { groupNames: { g1: 'Room' } }).map((c) => c.folder), [null, 'Room group folder'])
  })
})

describe('phases', () => {
  const step = (...actions) => actions.reduce(undoReducer, initialUndoPhase)
  it('loading → ready → submitting (no force) → done', () => {
    assert.equal(initialUndoPhase.kind, 'loading')
    const ready = step({ type: 'preview', preview: preview() })
    assert.equal(ready.kind, 'ready')
    const sub = undoReducer(ready, { type: 'submit' })
    assert.deepEqual([sub.kind, sub.force], ['submitting', false])
    assert.equal(undoReducer(sub, { type: 'undone' }).kind, 'done')
    assert.equal(undoReducer(ready, { type: 'undone' }), ready, 'only a submitting phase completes')
  })
  it('preview conflicts → conflicts; submit there is "Undo anyway" (force)', () => {
    const c = step({ type: 'preview', preview: preview({ conflicts: [{ path: 'workspace/sales.csv', root: 'agent' }] }) })
    assert.equal(c.kind, 'conflicts')
    const sub = undoReducer(c, { type: 'submit' })
    assert.deepEqual([sub.kind, sub.force], ['submitting', true])
  })
  it('POST 409 conflicts (changed after the preview) → conflicts with the new list', () => {
    const sub = step({ type: 'preview', preview: preview() }, { type: 'submit' })
    const c = undoReducer(sub, { type: 'undo_failed', error: undoErrorOf(apiErr(409, { error: 'x', reason: 'conflicts', conflicts: [{ path: 'workspace/sales.csv', root: 'agent' }] })) })
    assert.equal(c.kind, 'conflicts')
    assert.deepEqual(c.conflicts.map((x) => x.path), ['workspace/sales.csv'])
  })
  it('409 run_active and 410 gone, from the preview or the POST', () => {
    assert.equal(step({ type: 'preview_failed', error: undoErrorOf(apiErr(409, { error: 'x', reason: 'run_active' })) }).kind, 'run_active')
    assert.deepEqual(step({ type: 'preview_failed', error: undoErrorOf(apiErr(410, { error: 'x', reason: 'budget_bot' })) }), { kind: 'gone', reason: 'budget_bot', error: 'x' })
    const sub = step({ type: 'preview', preview: preview() }, { type: 'submit' })
    assert.equal(undoReducer(sub, { type: 'undo_failed', error: undoErrorOf(apiErr(409, { error: 'x', reason: 'run_active' })) }).kind, 'run_active')
    assert.deepEqual(undoReducer(sub, { type: 'undo_failed', error: undoErrorOf(apiErr(410, { error: 'x', reason: 'expired' })) }), { kind: 'gone', reason: 'expired', error: 'x' })
  })
  it('other failures: the preview → error; the POST → back to confirm with the message', () => {
    assert.deepEqual(step({ type: 'preview_failed', error: undoErrorOf(new Error('Boom')) }), { kind: 'error', message: 'Boom' })
    const sub = step({ type: 'preview', preview: preview() }, { type: 'submit' })
    const back = undoReducer(sub, { type: 'undo_failed', error: undoErrorOf(apiErr(500, {}, 'Disk error')) })
    assert.deepEqual([back.kind, back.error], ['ready', 'Disk error'])
    assert.equal(undoReducer(back, { type: 'submit' }).kind, 'submitting', 'can try again')
  })
  it('submit does nothing outside ready / conflicts; load restarts', () => {
    for (const p of [initialUndoPhase, { kind: 'gone', reason: 'expired' }, { kind: 'run_active' }, { kind: 'error', message: 'x' }]) assert.equal(undoReducer(p, { type: 'submit' }), p)
    assert.equal(undoReducer({ kind: 'error', message: 'x' }, { type: 'load' }).kind, 'loading')
  })
})

describe('footer', () => {
  const f = (phase) => {
    const x = undoFooter(phase)
    return [x.dismiss, x.primary?.label ?? null, x.primary?.disabled ?? null, x.busy]
  }
  it('per phase: Undo run / Undo anyway only when there are conflicts / Working… / Try again / Close', () => {
    assert.deepEqual(f({ kind: 'loading' }), ['Cancel', 'Undo run', true, false])
    assert.deepEqual(f({ kind: 'ready', preview: preview() }), ['Cancel', 'Undo run', false, false])
    assert.deepEqual(f({ kind: 'ready', preview: preview({ changes: [] }) }), ['Close', null, null, false])
    assert.deepEqual(f({ kind: 'conflicts', preview: preview(), conflicts: [{ path: 'a', root: 'agent' }] }), ['Cancel', 'Undo anyway', false, false])
    assert.deepEqual(f({ kind: 'submitting', preview: preview(), conflicts: [], force: false }), ['Cancel', 'Working…', true, true])
    assert.deepEqual(f({ kind: 'run_active' }), ['Close', 'Try again', false, false])
    assert.deepEqual(f({ kind: 'error', message: 'x' }), ['Close', 'Try again', false, false])
    assert.deepEqual(f({ kind: 'gone', reason: 'expired' }), ['Close', null, null, false])
    assert.equal(undoFooter({ kind: 'ready', preview: preview() }).primary.danger, true)
    assert.equal(undoFooter({ kind: 'run_active' }).primary.action, 'retry')
  })
})

describe('body markup (renderToStaticMarkup)', () => {
  it('ready matches mockup d: intro, delete/restore rows, the grey caveat note', () => {
    const html = render({ kind: 'ready', preview: preview() }, { run: cleanSales })
    assert.ok(html.includes('Your files go back to how they were right before this run:'))
    assert.ok(html.includes('<span class="undo-chg undo-chg--del">delete</span><span class="undo-path">workspace/sales.clean.csv</span><span class="undo-note">added by this run</span>'))
    assert.ok(html.includes('<span class="undo-chg">restore</span><span class="undo-path">workspace/sales.csv</span><span class="undo-note">modified by this run</span>'))
    assert.ok(html.includes('<p class="undo-note-box">Undo changes files only; it can&#x27;t take back anything a script sent over the internet.</p>'))
    assert.ok(!html.includes('undo-conflicts'))
  })
  it('no caveats → no grey note; group rows say whose folder', () => {
    const html = render({ kind: 'ready', preview: preview({ caveats: [], changes: [{ path: 'shared/pier.md', action: 'delete', root: 'group', groupId: 'g1' }] }) }, { groupNames: { g1: 'TL-1 Launch Room' } })
    assert.ok(!html.includes('undo-note-box'))
    assert.ok(html.includes('added by this run · TL-1 Launch Room group folder'))
  })
  it('conflicts list the files (role=alert)', () => {
    const html = render({ kind: 'conflicts', preview: preview(), conflicts: [{ path: 'workspace/sales.csv', root: 'agent' }] })
    assert.match(html, /<div class="undo-conflicts" role="alert"><p>These files changed after this run/)
    assert.ok(html.includes('<li><span class="undo-path">workspace/sales.csv</span></li>'))
  })
  it('410 shows the reason text', () => {
    const html = render({ kind: 'gone', reason: 'budget_bot' }, { botName: 'Analyst', budgetBytes: 2 * GB })
    assert.ok(html.includes('<div class="notice" role="alert">Undo no longer available: removed to stay within Analyst&#x27;s 2 GB undo space.</div>'))
  })
  it('run_active, error, loading, nothing to undo, a failed POST', () => {
    assert.ok(render({ kind: 'run_active' }, { botName: 'Analyst' }).includes('Analyst is running a script right now. You can undo once it finishes.'))
    assert.ok(render({ kind: 'error', message: 'Could not reach the API server.' }).includes('role="alert">Could not reach the API server.</div>'))
    assert.ok(render({ kind: 'loading' }).includes('aria-busy="true"'))
    assert.ok(render({ kind: 'ready', preview: preview({ changes: [] }) }).includes('nothing to undo'))
    assert.ok(render({ kind: 'ready', preview: preview(), error: 'Disk error' }).includes('notice notice--warn undo-err" role="alert">Disk error'))
    assert.equal(render({ kind: 'done' }), '<div></div>')
  })
})

describe('BE 77cc66e: preview sizes, group names, budget, machine_restored', () => {
  it('"151 KB → 158 KB original" from afterBytes → beforeBytes (mockup d)', () => {
    assert.equal(undoRowNote({ action: 'restore', afterBytes: 151 * 1024, beforeBytes: 158 * 1024 }), '151 KB → 158 KB original')
    const rows = undoRows(preview({ changes: [
      { path: 'workspace/sales.clean.csv', action: 'delete', root: 'agent', afterBytes: 148 * 1024, beforeBytes: null },
      { path: 'workspace/sales.csv', action: 'restore', root: 'agent', afterBytes: 151 * 1024, beforeBytes: 158 * 1024 },
    ] }), cleanSales)
    assert.deepEqual(rows.map((r) => r.note), ['added by this run', '151 KB → 158 KB original'])
  })
  it('null on the side that does not exist: added → "added by this run", deleted → "deleted by this run · N original"', () => {
    assert.equal(undoRowNote({ action: 'delete', afterBytes: 2048, beforeBytes: null }), 'added by this run')
    assert.equal(undoRowNote({ action: 'restore', afterBytes: null, beforeBytes: 2048 }), 'deleted by this run · 2 KB original')
    assert.equal(undoRowNote({ action: 'restore', afterBytes: null, beforeBytes: null }), 'deleted by this run')
    assert.equal(undoRowNote({ action: 'restore', afterBytes: null }), 'deleted by this run')
  })
  it('no sizes (older BE): falls back to the run\'s filesChanged', () => {
    assert.equal(undoRowNote({ action: 'restore' }, 'modified'), 'modified by this run')
    assert.equal(undoRowNote({ action: 'restore' }, 'deleted'), 'deleted by this run')
    assert.equal(undoRowNote({ action: 'restore', afterBytes: 10 }), 'modified by this run', 'one side only: no arrow')
  })
  it('groupName wins over the caller map, which stays as the fallback', () => {
    const p = preview({ changes: [
      { path: 'shared/a.md', action: 'restore', root: 'group', groupId: 'g1', groupName: 'Launch Room' },
      { path: 'shared/b.md', action: 'restore', root: 'group', groupId: 'g1' },
    ], conflicts: [{ path: 'shared/a.md', root: 'group', groupId: 'g1', groupName: 'Launch Room' }] })
    const ctx = { groupNames: { g1: 'Old Name' } }
    assert.deepEqual(undoRows(p, undefined, ctx).map((r) => r.folder), ['Launch Room group folder', 'Old Name group folder'])
    assert.equal(conflictRows(p.conflicts, ctx)[0].folder, 'Launch Room group folder')
  })
  it('budget_bot after a loaded preview: the preview budget beats budgetBytes', () => {
    const sub = undoReducer(undoReducer(initialUndoPhase, { type: 'preview', preview: preview({ budget: { usedBytes: GB, limitBytes: 3 * GB } }) }), { type: 'submit' })
    const gone = undoReducer(sub, { type: 'undo_failed', error: undoErrorOf(apiErr(410, { error: 'x', reason: 'budget_bot' })) })
    assert.equal(gone.budgetBytes, 3 * GB)
    assert.match(render(gone, { botName: 'Analyst', budgetBytes: 2 * GB }), /Analyst&#x27;s 3 GB undo space/)
    const fromPreview = undoReducer(initialUndoPhase, { type: 'preview_failed', error: undoErrorOf(apiErr(410, { error: 'x', reason: 'budget_bot' })) })
    assert.match(render(fromPreview, { botName: 'Analyst', budgetBytes: 2 * GB }), /Analyst&#x27;s 2 GB undo space/, 'no preview: budgetBytes')
  })
  it('machine_restored shows the 410 text as is, else Team lead\'s sentence', () => {
    const gone = undoReducer(initialUndoPhase, { type: 'preview_failed', error: undoErrorOf(apiErr(410, { error: UNDO_MACHINE_RESTORED_TEXT, reason: 'machine_restored' }, UNDO_MACHINE_RESTORED_TEXT)) })
    assert.ok(render(gone).includes("This bot&#x27;s computer was restored from a backup, so this run can&#x27;t be undone."))
    assert.equal(undoGoneText('machine_restored'), "This bot's computer was restored from a backup, so this run can't be undone.")
    assert.equal(undoGoneText('machine_restored', { error: 'Restored on Oct 2.' }), 'Restored on Oct 2.')
  })
})
