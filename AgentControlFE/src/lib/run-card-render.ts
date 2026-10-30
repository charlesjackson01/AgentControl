/** FE-P2-2: the run card's markup (mockup a-run-cards). Plain .ts (createElement) so tests can render it. */
import { createElement as h, type ReactNode, type Ref } from 'react'
import { runCardLabel, type RunCardView } from './run-card.ts'

export type RunCardHandlers = {
  /** M2: the browser run's screenshot URL (RunCard resolves it through the files route). */
  thumbUrl?: string | null
  /** Header toggle (the mockup's ▾); omitted = always open. */
  open?: boolean
  onToggle?: () => void
  bodyId?: string
  onStop?: () => void
  stopping?: boolean
  stopError?: string | null
  onUndo?: () => void
  onOutput?: () => void
  /** Details failed to load (GAP-R13). */
  loadError?: string | null
  onRetry?: () => void
  /** Refs so the card can put focus back after a dialog (the opener may be gone). */
  undoRef?: Ref<HTMLButtonElement>
  outputRef?: Ref<HTMLButtonElement>
}

const CHG_CLASS = { added: 'rc-chg rc-chg--add', modified: 'rc-chg', deleted: 'rc-chg rc-chg--del' } as const

function head(v: RunCardView, x: RunCardHandlers): ReactNode {
  const inner = [
    h('span', { key: 'pill', className: 'rc-pill', 'aria-hidden': 'true' }, v.pillIcon, h('span', { className: 'rc-pill__txt' }, v.pill)),
    h('span', { key: 'name', className: 'rc-name' }, v.name),
    v.source ? h('span', { key: 'src', className: 'rc-src' }, v.source) : null,
    h('span', { key: 'sp', className: 'rc-sp' }),
    h(
      'span',
      { key: 'st', className: `rc-st rc-st--${v.tone}` },
      h('span', { className: v.spinner ? 'rc-spin' : 'rc-dot', 'aria-hidden': 'true' }),
      h('span', { 'aria-hidden': v.status === 'running' ? 'true' : undefined }, v.statusText),
      v.status === 'running' ? h('span', { className: 'sr-only' }, v.statusLabel) : null,
    ),
    x.onToggle ? h('span', { key: 'chev', className: 'rc-chev', 'aria-hidden': 'true' }, x.open === false ? '▸' : '▾') : null,
  ]
  if (!x.onToggle) return h('div', { className: 'rc-head' }, ...inner)
  return h(
    'button',
    { type: 'button', className: 'rc-head', 'aria-expanded': x.open !== false, 'aria-controls': x.bodyId, onClick: x.onToggle, 'aria-label': runCardLabel(v) },
    ...inner,
  )
}

function actions(v: RunCardView, x: RunCardHandlers): ReactNode {
  const btns: ReactNode[] = []
  if (v.actions.stop)
    btns.push(
      h('button', { key: 'stop', type: 'button', className: 'btn rc-btn', onClick: x.onStop, disabled: x.stopping || !x.onStop }, x.stopping ? 'Stopping…' : '■ Stop'),
    )
  if (v.actions.undo) btns.push(h('button', { key: 'undo', type: 'button', className: 'btn rc-btn', onClick: x.onUndo, ref: x.undoRef }, '↶ Undo run'))
  if (v.actions.output)
    btns.push(h('button', { key: 'out', type: 'button', className: 'btn btn--ghost rc-btn', onClick: x.onOutput, ref: x.outputRef }, 'Full output'))
  const note = v.note ? h('span', { key: 'note', className: 'rc-note' }, v.note) : null
  const sp = h('span', { key: 'sp', className: 'rc-sp' })
  const parts = v.noteFirst ? [note, sp, ...btns] : [...btns, sp, note]
  return h('div', { className: `rc-acts${v.noteFirst ? ' rc-acts--note-first' : ''}` }, ...parts)
}

function log(v: RunCardView): ReactNode {
  if (!v.log) return null
  return h(
    'div',
    { key: 'log', className: `rc-log${v.log.error ? ' rc-log--err' : ''}${v.log.live ? ' rc-log--live' : ''}` },
    h('span', { className: 'rc-log__txt' }, v.log.text, v.log.live ? h('span', { className: 'rc-caret', 'aria-hidden': 'true' }, ' ▍') : null),
  )
}

function hosts(v: RunCardView): ReactNode {
  if (!v.hosts) return null
  return h(
    'div',
    { key: 'hosts', className: 'rc-hostsw' },
    h('div', { className: 'rc-hosts__h' }, v.hosts.title),
    h(
      'ul',
      { className: 'rc-hosts', 'aria-label': v.hosts.title },
      ...v.hosts.rows.map((r) =>
        h(
          'li',
          { key: r.key },
          h('span', { className: `rc-hk${r.blocked ? ' rc-hk--bad' : ''}` }, r.label),
          h('span', { className: 'rc-path' }, r.host),
          h('span', { className: 'rc-size' }, r.note),
        ),
      ),
      v.hosts.more > 0 ? h('li', { key: 'more', className: 'rc-more' }, `+ ${v.hosts.more} more ${v.hosts.more === 1 ? 'site' : 'sites'}`) : null,
    ),
  )
}

function body(v: RunCardView, x: RunCardHandlers): ReactNode[] {
  if (v.loading) {
    if (x.loadError)
      return [
        h(
          'p',
          { key: 'le', className: 'rc-loaderr', role: 'alert' },
          x.loadError,
          ' ',
          x.onRetry ? h('button', { type: 'button', className: 'chat__retry', onClick: x.onRetry }, 'Retry') : null,
        ),
        v.actions.stop ? actions(v, x) : null,
      ]
    return [
      h('div', { key: 'sk', className: 'rc-skel', 'aria-busy': 'true' }, h('span', { className: 'skeleton' }), h('span', { className: 'skeleton' })),
      v.actions.stop ? actions(v, x) : null,
    ]
  }
  return [
    v.command ? h('div', { key: 'cmd', className: 'rc-cmd' }, v.command) : null,
    v.meta.length
      ? h(
          'div',
          { key: 'meta', className: 'rc-meta' },
          ...v.meta.map((m) => h('span', { key: m.key }, `${m.label} `, h('b', null, m.value), m.suffix ? ` ${m.suffix}` : null)),
        )
      : null,
    v.files.length
      ? h(
          'ul',
          { key: 'files', className: 'rc-files', 'aria-label': 'Files changed' },
          ...v.files.map((f) =>
            h(
              'li',
              { key: f.key },
              h('span', { className: CHG_CLASS[f.change] }, f.change),
              h('span', { className: 'rc-path' }, f.path),
              f.folder ? h('span', { className: 'rc-folder' }, f.folder) : null,
              f.size ? h('span', { className: 'rc-size' }, f.size) : null,
            ),
          ),
          v.moreFiles > 0 ? h('li', { key: 'more', className: 'rc-more' }, `+ ${v.moreFiles} more ${v.moreFiles === 1 ? 'file' : 'files'}`) : null,
        )
      : null,
    v.thumb && x.thumbUrl
      ? h('img', { key: 'shot', className: 'rc-shot', src: x.thumbUrl, alt: `Screenshot preview: ${v.thumb.path}`, loading: 'lazy' })
      : null,
    v.wait ? h('div', { key: 'wait', className: 'rc-wait' }, v.wait) : null,
    // Mockup 07: a live log sits above "Sites used so far"; mockups 06/08: ended cards list sites first.
    v.log?.live ? log(v) : null,
    hosts(v),
    v.error && !v.errorLast ? h('p', { key: 'err', className: 'rc-error' }, v.error) : null,
    v.log && !v.log.live ? log(v) : null,
    v.error && v.errorLast ? h('p', { key: 'err', className: 'rc-error' }, v.error) : null,
    v.truncated ? h('p', { key: 'trunc', className: 'rc-trunc' }, v.truncated) : null,
    actions(v, x),
    x.stopError ? h('p', { key: 'serr', className: 'field__err rc-stoperr', role: 'alert' }, x.stopError) : null,
  ]
}

/** The whole card. The body is hidden (not removed) when collapsed. */
export function renderRunCard(v: RunCardView, x: RunCardHandlers = {}): ReactNode {
  const cls = `rc${v.bad ? ' rc--bad' : ''}${v.tone === 'undone' ? ' rc--muted' : ''}`
  return h(
    'div',
    { className: cls, role: 'group', 'aria-label': runCardLabel(v), 'data-status': v.status, 'data-kind': v.kind },
    head(v, x),
    v.progress ? h('div', { className: 'rc-bar', 'aria-hidden': 'true' }, h('span', null)) : null,
    h('div', { className: `rc-body${v.progress ? ' rc-body--bar' : ''}`, id: x.bodyId, hidden: x.open === false }, ...body(v, x)),
  )
}
