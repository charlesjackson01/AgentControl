/** FE-P2-5: the VM tab's markup (mockups c-settings-vm-tab-v2*). Plain .ts (createElement) so tests can render it. */
import { createElement as h, type ReactNode } from 'react'
import { ENV_SECRET_NOTE, HOME_NETWORK_TEXT, INTERNET_OPTIONS, INTERNET_TEXT, BROWSER_LATER_TEXT, environmentHint, environmentTitle, noToolsText, permissionsHint, type EnvErrors, type HistoryRowView, type MeterView, type VmTabModel } from './vm-tab.ts'
import type { InternetPolicy, RuntimeMode } from './types.ts'

export type VmBusy = null | 'start' | 'stop' | 'reset' | 'internet' | 'gvisor' | 'probe' | 'env' | 'grow' | 'more'

export type EnvEditor = { index: number; name: string; value: string; errors: EnvErrors | null }

export type VmTabUi = {
  busy: VmBusy
  /** Inline error per section. */
  errors: Partial<Record<'head' | 'perm' | 'iso' | 'env' | 'files' | 'history', string>>
  editor: EnvEditor | null
  /** "Checked just now" etc. after Re-check. */
  probeNote?: string | null
  hasMore: boolean
  exportHref?: string
  /** Row being opened (Undo / Output load the full run first). */
  opening?: string | null
}

export type VmTabHandlers = {
  onStart?: () => void
  onStop?: () => void
  onReset?: () => void
  onInternet?: (v: InternetPolicy) => void
  onGvisor?: (v: RuntimeMode) => void
  onRecheck?: () => void
  onDetails?: () => void
  onEnvEdit?: (index: number) => void
  onEnvAdd?: () => void
  onEnvChange?: (field: 'name' | 'value', v: string) => void
  onEnvSave?: () => void
  onEnvCancel?: () => void
  onEnvRemove?: () => void
  onUndo?: (runId: string) => void
  onOutput?: (runId: string) => void
  onMore?: () => void
  onGrow?: (toGb: number) => void
}

const err = (text: string | undefined, key = 'err') => (text ? h('p', { key, className: 'vm-err', role: 'alert' }, text) : null)
const btn = (key: string, label: string, onClick: (() => void) | undefined, opts: { ghost?: boolean; disabled?: boolean; danger?: boolean } = {}) =>
  h('button', { key, type: 'button', className: `btn${opts.ghost ? ' btn--ghost' : ''}${opts.danger ? ' btn--danger' : ''}`, onClick, disabled: opts.disabled }, label)

function segmented<T extends string>(label: string, options: readonly { value: T; label: string }[], value: T, onPick: ((v: T) => void) | undefined, disabled: boolean): ReactNode {
  return h(
    'div',
    { className: 'segmented vm-seg', role: 'radiogroup', 'aria-label': label },
    ...options.map((o) =>
      h(
        'button',
        {
          key: o.value,
          type: 'button',
          role: 'radio',
          'aria-checked': o.value === value,
          className: `segmented__opt${o.value === value ? ' segmented__opt--on' : ''}`,
          disabled,
          onClick: () => o.value !== value && onPick?.(o.value),
        },
        o.label,
      ),
    ),
  )
}

function meter(m: MeterView): ReactNode {
  return h(
    'div',
    { key: m.key, className: 'vm-lim__c' },
    h('span', { className: 'vm-lim__k' }, m.label),
    h('span', { className: 'vm-lim__v' }, m.value, m.of ? h('small', null, ` ${m.of}`) : null),
    m.pct === null
      ? m.note
        ? h('span', { className: 'cf-meter__t' }, m.note)
        : null
      : h(
          'div',
          { className: `cf-meter${m.tone === 'warn' ? ' cf-meter--warn' : m.tone === 'bad' ? ' cf-meter--bad' : ''}` },
          h('span', { className: 'cf-meter__bar', role: 'meter', 'aria-label': m.label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': m.pct }, h('span', { style: { width: `${m.pct}%` } })),
          m.note ? h('span', { className: 'cf-meter__t' }, m.note) : null,
        ),
  )
}

function headCard(m: VmTabModel, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  const hd = m.header
  const off = hd.busy || ui.busy !== null
  return h(
    'section',
    { key: 'head', className: 'cf-card' },
    h(
      'div',
      { className: 'vm-head' },
      h('span', { className: `vm-st vm-st--${hd.tone}` }, h('span', { className: hd.spinner ? 'vm-spin' : 'vm-dot', 'aria-hidden': 'true' }), hd.badge),
      h('div', { className: 'vm-head__txt' }, h('h3', null, hd.title), h('p', null, hd.subtitle)),
      h(
        'div',
        { className: 'vm-head__btns' },
        hd.start ? btn('start', ui.busy === 'start' ? 'Starting…' : hd.start, x.onStart, { disabled: off }) : null,
        hd.stop ? btn('stop', ui.busy === 'stop' ? 'Stopping…' : 'Stop', x.onStop, { disabled: off }) : null,
        hd.reset ? btn('reset', 'Reset VM…', x.onReset, { ghost: true, disabled: off }) : null,
      ),
    ),
    hd.banner ? h('div', { className: 'vm-banner', role: 'status' }, hd.banner) : null,
    hd.message ? h('p', { className: `vm-sub${hd.tone === 'bad' && !hd.banner ? ' vm-sub--bad' : ''}` }, hd.message) : null,
    err(ui.errors.head),
    h('div', { className: 'vm-lim' }, ...m.meters.map(meter)),
  )
}

function permsCard(m: VmTabModel, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  return h(
    'section',
    { key: 'perm', className: 'cf-card' },
    h('h3', { className: 'cf-card__title' }, 'Permissions'),
    h('p', { className: 'cf-card__hint' }, permissionsHint(m.botName)),
    h(
      'div',
      { className: 'vm-row vm-row--top' },
      h(
        'div',
        { className: 'vm-row__txt' },
        h('div', { className: 'vm-row__t' }, 'Internet'),
        h('div', { className: 'vm-row__s' }, INTERNET_TEXT),
        segmented('Internet for scripts', INTERNET_OPTIONS, m.internetPolicy, x.onInternet, ui.busy === 'internet'),
      ),
    ),
    h(
      'div',
      { className: 'vm-row' },
      h(
        'div',
        { className: 'vm-row__txt' },
        h('div', { className: 'vm-row__t' }, 'Browser (Playwright)'),
        h('div', { className: 'vm-row__s' }, m.browserText),
        h('div', { className: 'vm-row__s vm-later' }, BROWSER_LATER_TEXT),
      ),
      // M1 ruling: shown, never enabled (PATCH browser:true is a 400 in M1).
      h('button', { type: 'button', className: `switch cf-toggle${m.browserOn ? ' switch--on' : ''}`, role: 'switch', 'aria-checked': m.browserOn, 'aria-label': 'Browser (Playwright)', disabled: true }),
    ),
    h(
      'div',
      { className: 'vm-row' },
      h('div', { className: 'vm-row__txt' }, h('div', { className: 'vm-row__t' }, 'Home network & Tailscale'), h('div', { className: 'vm-row__s' }, HOME_NETWORK_TEXT)),
      h('span', { className: 'vm-lock' }, 'Blocked in Phase 2'),
    ),
    err(ui.errors.perm),
  )
}

function isolationCard(m: VmTabModel, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  const iso = m.isolation
  return h(
    'section',
    { key: 'iso', className: 'cf-card' },
    h('div', { className: 'vm-cardhd' }, h('h3', { className: 'cf-card__title' }, 'Isolation'), h('span', { className: `vm-gv vm-gv--${iso.tone}` }, iso.badge)),
    h('p', { className: 'cf-card__hint' }, iso.text, iso.checked ? ` ${iso.checked}` : null),
    m.isolationNote ? h('p', { className: 'vm-note' }, m.isolationNote) : null,
    h(
      'div',
      { className: 'vm-row vm-row--top' },
      h(
        'div',
        { className: 'vm-row__txt' },
        h('div', { className: 'vm-row__t' }, `gVisor for ${m.botName}`),
        segmented(`gVisor for ${m.botName}`, m.modeOptions, m.runtimeMode, x.onGvisor, ui.busy === 'gvisor'),
        h('div', { className: 'vm-sub' }, iso.hint),
      ),
    ),
    h('div', { className: 'vm-btnrow' }, btn('recheck', ui.busy === 'probe' ? 'Checking…' : 'Re-check now', x.onRecheck, { disabled: ui.busy === 'probe' }), ui.probeNote ? h('span', { className: 'vm-sub vm-inline' }, ui.probeNote) : null),
    err(ui.errors.iso),
  )
}

function envEditor(ed: EnvEditor, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  const saving = ui.busy === 'env'
  const nameId = `vm-env-name-${ed.index}`
  return h(
    'tr',
    { key: `edit-${ed.index}`, className: 'vm-env__edit' },
    h(
      'td',
      { colSpan: 3 },
      h(
        'div',
        { className: 'vm-env__form' },
        h(
          'label',
          { className: 'vm-env__f' },
          h('span', null, 'Name'),
          h('input', {
            id: nameId,
            className: `input vm-mono${ed.errors?.name ? ' input--invalid' : ''}`,
            value: ed.name,
            autoFocus: true,
            spellCheck: false,
            'aria-invalid': ed.errors?.name ? true : undefined,
            'aria-describedby': ed.errors?.name ? `${nameId}-err` : undefined,
            onChange: (e: { target: { value: string } }) => x.onEnvChange?.('name', e.target.value),
          }),
          ed.errors?.name ? h('span', { id: `${nameId}-err`, className: 'vm-err', role: 'alert' }, ed.errors.name) : null,
        ),
        h(
          'label',
          { className: 'vm-env__f vm-env__f--val' },
          h('span', null, 'Value'),
          h('input', {
            className: `input vm-mono${ed.errors?.value ? ' input--invalid' : ''}`,
            value: ed.value,
            spellCheck: false,
            'aria-invalid': ed.errors?.value ? true : undefined,
            onChange: (e: { target: { value: string } }) => x.onEnvChange?.('value', e.target.value),
          }),
          ed.errors?.value ? h('span', { className: 'vm-err', role: 'alert' }, ed.errors.value) : null,
        ),
        h(
          'div',
          { className: 'vm-btnrow' },
          btn('save', saving ? 'Saving…' : 'Save', x.onEnvSave, { disabled: saving }),
          btn('cancel', 'Cancel', x.onEnvCancel, { ghost: true, disabled: saving }),
          ed.index >= 0 ? btn('remove', 'Remove', x.onEnvRemove, { ghost: true, disabled: saving }) : null,
        ),
      ),
    ),
  )
}

function envCard(m: VmTabModel, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  const ed = ui.editor
  const rows: ReactNode[] = m.env.map((e, i) =>
    ed && ed.index === i
      ? envEditor(ed, ui, x)
      : h(
          'tr',
          { key: e.name },
          h('td', null, e.name),
          h('td', null, e.value),
          h('td', null, h('button', { type: 'button', className: 'vm-link', onClick: () => x.onEnvEdit?.(i), disabled: !!ed, 'aria-label': `Edit ${e.name}` }, 'edit')),
        ),
  )
  if (ed && ed.index < 0) rows.push(envEditor(ed, ui, x))
  const t = m.tools
  return h(
    'section',
    { key: 'env', className: 'cf-card' },
    h('h3', { className: 'cf-card__title' }, environmentTitle(m.botName)),
    h('p', { className: 'cf-card__hint' }, environmentHint(m.botName)),
    h(
      'div',
      { className: 'vm-row vm-row--mt' },
      h(
        'div',
        { className: 'vm-row__txt' },
        h('div', { className: 'vm-row__t' }, 'Installed tools'),
        h(
          'div',
          { className: 'vm-row__s' },
          t
            ? [
                t.text,
                t.system.length ? `${t.text ? ' · ' : ''}system: ` : null,
                ...t.system.flatMap((p, i) => [i ? ', ' : null, h('code', { key: p }, p)]),
                t.built ? ` (${t.built})` : null,
              ]
            : noToolsText(m.botName),
        ),
      ),
      btn('details', 'Details', x.onDetails, { ghost: true }),
    ),
    rows.length ? h('table', { className: 'vm-env' }, h('tbody', null, ...rows)) : null,
    ed && ed.index < 0 ? null : h('div', { className: 'vm-btnrow' }, btn('add', 'Add variable', x.onEnvAdd, { disabled: !!ed })),
    err(ui.errors.env),
    h('div', { className: 'vm-sub' }, ENV_SECRET_NOTE),
  )
}

function noticesCard(m: VmTabModel, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  if (!m.notices.length) return null
  return h(
    'div',
    { key: 'notices', className: 'vm-notices' },
    ...m.notices.map((n) =>
      h(
        'div',
        { key: n.id, className: `vm-notice vm-notice--${n.tone}`, role: n.tone === 'warn' ? 'alert' : undefined },
        h('span', null, n.text),
        n.action
          ? btn(`grow`, ui.busy === 'grow' ? 'Growing…' : n.action.label, () => x.onGrow?.(n.action!.toGb), { disabled: ui.busy !== null || m.runActive })
          : null,
      ),
    ),
  )
}

function filesCard(m: VmTabModel, ui: VmTabUi): ReactNode {
  const f = m.files
  return h(
    'section',
    { key: 'files', className: 'cf-card' },
    h('h3', { className: 'cf-card__title' }, `Where ${m.botName}'s files live`),
    h('p', { className: 'cf-card__hint' }, f.before, f.code ? h('code', null, f.code) : null, f.after),
    f.backup
      ? h('div', { className: 'vm-row vm-row--mt' }, h('div', { className: 'vm-row__txt' }, h('div', { className: 'vm-row__t' }, 'Backup'), h('div', { className: 'vm-row__s' }, f.backup)))
      : null,
    f.exportLabel && ui.exportHref ? h('div', { className: 'vm-btnrow' }, h('a', { className: 'btn', href: ui.exportHref, download: true }, f.exportLabel)) : null,
    err(ui.errors.files),
  )
}

function historyItem(r: HistoryRowView, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  const opening = ui.opening === r.id
  return h(
    'li',
    { key: r.id },
    h('span', { className: `vm-hist__${r.iconTone}`, 'aria-hidden': 'true' }, r.icon),
    h('div', { className: 'vm-hist__body' }, h('div', { className: 'vm-hist__n' }, r.name), h('div', { className: 'vm-hist__s' }, r.meta)),
    h('span', { className: 'vm-hist__t' }, r.time),
    r.gone
      ? h('span', { className: 'vm-gone' }, 'no undo')
      : r.action === 'undo'
        ? h('button', { type: 'button', className: 'btn', disabled: opening, onClick: () => x.onUndo?.(r.id), 'aria-label': `Undo ${r.name}` }, 'Undo')
        : r.action === 'output'
          ? h('button', { type: 'button', className: 'btn btn--ghost', disabled: opening, onClick: () => x.onOutput?.(r.id), 'aria-label': `Output of ${r.name}` }, 'Output')
          : h('span', null),
  )
}

function historyCard(m: VmTabModel, ui: VmTabUi, x: VmTabHandlers): ReactNode {
  return h(
    'section',
    { key: 'hist', className: 'cf-card' },
    h('div', { className: 'vm-cardhd' }, h('h3', { className: 'cf-card__title' }, 'Run history'), h('span', null, m.retention)),
    m.rows.length ? h('ul', { className: 'vm-hist' }, ...m.rows.map((r) => historyItem(r, ui, x))) : h('p', { className: 'vm-sub' }, `No runs yet. ${m.botName}'s scripts show here.`),
    err(ui.errors.history),
    ui.hasMore ? h('div', { className: 'vm-btnrow' }, btn('more', ui.busy === 'more' ? 'Loading…' : 'Show older runs', x.onMore, { ghost: true, disabled: ui.busy === 'more' })) : null,
  )
}

/** The tab body: the mockup's card order (status, permissions, isolation, files; then environment and history). */
export function renderVmTab(m: VmTabModel, ui: VmTabUi, x: VmTabHandlers = {}): ReactNode {
  return h(
    'div',
    { className: 'cf-set__stack vm-tab' },
    headCard(m, ui, x),
    noticesCard(m, ui, x),
    permsCard(m, ui, x),
    isolationCard(m, ui, x),
    filesCard(m, ui),
    envCard(m, ui, x),
    historyCard(m, ui, x),
  )
}
