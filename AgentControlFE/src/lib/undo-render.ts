/** FE-P2-4: the undo dialog's body markup. Plain .ts (createElement) so tests can render it. */
import { createElement as h, type ReactNode } from 'react'
import type { ScriptRun } from './types.ts'
import {
  CONFLICTS_TEXT, INTRO_TEXT, NOTHING_TEXT, caveatText, conflictRows, runActiveText, undoGoneText, undoRows,
  type UndoPhase, type UndoReasonContext, type UndoRowContext,
} from './undo.ts'

export type UndoBodyContext = UndoRowContext & UndoReasonContext & {
  run?: Pick<ScriptRun, 'filesChanged'>
}

function changeList(phase: Extract<UndoPhase, { preview: unknown }>, ctx: UndoBodyContext): ReactNode {
  const preview = phase.preview
  if (!preview) return null
  const rows = undoRows(preview, ctx.run, ctx)
  return h(
    'ul',
    { className: 'undo-list', 'aria-label': 'What undo changes' },
    ...rows.map((r) =>
      h(
        'li',
        { key: r.key },
        h('span', { className: `undo-chg${r.action === 'delete' ? ' undo-chg--del' : ''}` }, r.action),
        h('span', { className: 'undo-path' }, r.path),
        h('span', { className: 'undo-note' }, r.folder ? `${r.note} · ${r.folder}` : r.note),
      ),
    ),
  )
}

function conflictList(conflicts: Parameters<typeof conflictRows>[0], ctx: UndoBodyContext): ReactNode {
  return h(
    'div',
    { className: 'undo-conflicts', role: 'alert' },
    h('p', null, CONFLICTS_TEXT),
    h(
      'ul',
      { className: 'undo-list' },
      ...conflictRows(conflicts, ctx).map((c) =>
        h('li', { key: c.key }, h('span', { className: 'undo-path' }, c.path), c.folder ? h('span', { className: 'undo-note' }, c.folder) : null),
      ),
    ),
  )
}

function caveatNote(phase: Extract<UndoPhase, { preview: unknown }>): ReactNode {
  const text = phase.preview ? caveatText(phase.preview.caveats) : null
  return text ? h('p', { className: 'undo-note-box' }, text) : null
}

/** The dialog body for each phase (the footer is undoFooter in undo.ts). */
export function renderUndoBody(phase: UndoPhase, ctx: UndoBodyContext = {}): ReactNode {
  switch (phase.kind) {
    case 'loading':
      return h(
        'div',
        { className: 'undo-body', 'aria-busy': 'true' },
        h('p', { className: 'undo-intro', role: 'status' }, 'Checking what this run changed…'),
        h('div', { className: 'undo-skel' }, h('span', { className: 'skeleton' }), h('span', { className: 'skeleton' })),
      )
    case 'ready':
      if (phase.preview.changes.length === 0) return h('div', { className: 'undo-body' }, h('p', { className: 'undo-intro' }, NOTHING_TEXT))
      return h(
        'div',
        { className: 'undo-body' },
        h('p', { className: 'undo-intro' }, INTRO_TEXT),
        changeList(phase, ctx),
        caveatNote(phase),
        phase.error ? h('div', { className: 'notice notice--warn undo-err', role: 'alert' }, phase.error) : null,
      )
    case 'conflicts':
    case 'submitting':
      return h(
        'div',
        { className: 'undo-body' },
        h('p', { className: 'undo-intro' }, INTRO_TEXT),
        changeList(phase, ctx),
        phase.conflicts.length > 0 ? conflictList(phase.conflicts, ctx) : null,
        caveatNote(phase),
        phase.kind === 'conflicts' && phase.error ? h('div', { className: 'notice notice--warn undo-err', role: 'alert' }, phase.error) : null,
      )
    case 'run_active':
      return h('div', { className: 'undo-body' }, h('div', { className: 'notice notice--info', role: 'status' }, runActiveText(ctx.botName)))
    case 'gone':
      return h('div', { className: 'undo-body' }, h('div', { className: 'notice', role: 'alert' }, undoGoneText(phase.reason, ctx)))
    case 'error':
      return h('div', { className: 'undo-body' }, h('div', { className: 'notice notice--warn', role: 'alert' }, phase.message))
    case 'done':
      return null
  }
}
