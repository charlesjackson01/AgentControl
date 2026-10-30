/** FE-P2-3: the permission card's markup (mockups 01–05, 09, 10). Plain .ts (createElement) so tests can render it. */
import { createElement as h, type ReactNode } from 'react'
import type { ActionButton, CardAction, DecisionButton, PermissionCardView, Seg, SetupStep } from './permission-card.ts'
import type { PermissionDecision } from './types.ts'

export type PermissionCardHandlers = {
  onDecide?: (decision: PermissionDecision) => void
  onAction?: (action: CardAction) => void
  /** The decision or action in flight (its button shows a spinner; all buttons are disabled). */
  busy?: PermissionDecision | CardAction | null
  /** Where "Settings › VM" goes (absent: plain text). */
  settingsHref?: string
  onSettings?: () => void
}

const ICON = { internet: '🌐', browser: '🧭' } as const
const BTN = { primary: 'btn btn--primary', plain: 'btn', ghost: 'btn btn--ghost' } as const

function segs(list: readonly Seg[], x: PermissionCardHandlers): ReactNode[] {
  return list.map((s, i) => {
    if (typeof s === 'string') return s
    if ('code' in s) return h('code', { key: i }, s.code)
    if ('b' in s) return h('b', { key: i }, s.b)
    if (!x.settingsHref) return s.text
    return h(
      'a',
      {
        key: i,
        href: x.settingsHref,
        onClick: x.onSettings
          ? (e: { preventDefault: () => void }) => {
              e.preventDefault()
              x.onSettings?.()
            }
          : undefined,
      },
      s.text,
    )
  })
}

function top(v: PermissionCardView, x: PermissionCardHandlers, pill?: ReactNode): ReactNode {
  const title = typeof v.title === 'string' ? v.title : segs(v.title, x)
  return h(
    'div',
    { className: 'pc-top' },
    h('span', { className: 'pc-ico', 'aria-hidden': 'true' }, ICON[v.kind]),
    h('div', { className: 'pc-txt' }, h('p', { className: 'pc-t' }, ...[title].flat()), h('p', { className: 'pc-s' }, ...segs(v.sub, x))),
    pill,
  )
}

function button(b: DecisionButton | ActionButton, key: string, x: PermissionCardHandlers, onClick: () => void): ReactNode {
  const busy = x.busy === key
  return h(
    'button',
    { key: b.key, type: 'button', className: BTN[b.cls], disabled: Boolean(x.busy), 'aria-busy': busy ? 'true' : undefined, onClick },
    busy ? h('span', { className: 'spinner', 'aria-hidden': 'true' }) : null,
    b.label,
  )
}

function step(s: SetupStep): ReactNode {
  const icon = s.state === 'ok' ? '✓' : s.state === 'run' ? '●' : '○'
  return h(
    'li',
    { key: s.key, className: s.state === 'dim' ? 'dim' : undefined },
    h('span', { className: s.state === 'dim' ? 'i' : `i i--${s.state}`, 'aria-hidden': 'true' }, icon),
    h('span', null, s.label),
    h('span', { className: 'm' }, s.meta ?? ''),
    typeof s.progress === 'number'
      ? h(
          'div',
          { className: 'pc-prog', role: 'progressbar', 'aria-label': s.label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': s.progress },
          h('span', { style: { width: `${s.progress}%` } }),
        )
      : null,
  )
}

export function renderPermissionCard(v: PermissionCardView, x: PermissionCardHandlers = {}): ReactNode {
  if (v.mode === 'pending') {
    return h(
      'div',
      { className: 'pc', role: 'group', 'aria-label': v.label },
      top(v, x),
      v.hosts.length
        ? h(
            'div',
            { className: 'pc-hosts' },
            h('span', { className: 'pc-hlbl' }, v.hostsLabel),
            ...v.hosts.map((host) => h('span', { key: host, className: 'pc-host' }, host)),
            v.moreHosts ? h('span', { key: 'more', className: 'pc-hlbl' }, `+${v.moreHosts} more`) : null,
          )
        : null,
      h('div', { className: 'pc-btns' }, ...v.buttons.map((b) => button(b, b.decision, x, () => x.onDecide?.(b.decision)))),
      v.error ? h('p', { className: 'pc-err', role: 'alert' }, v.error) : null,
      h(
        'div',
        { className: 'pc-foot' },
        h('span', null, ...segs(v.foot, x)),
        h('span', { className: v.timerLow ? 'pc-timer pc-timer--low' : 'pc-timer' }, `⏱ ${v.timer}`),
      ),
    )
  }
  const bad = v.tone === 'bad'
  return h(
    'div',
    { className: `pc pc--done${bad ? ' pc--bad' : ''}`, role: 'group', 'aria-label': v.label },
    top(v, x, h('span', { className: `pc-st pc-st--${v.tone}` }, v.pill)),
    v.steps.length ? h('ul', { className: 'pc-steps' }, ...v.steps.map(step)) : null,
    v.next ? h('div', { className: 'pc-next' }, v.next) : null,
    v.buttons.length ? h('div', { className: 'pc-btns' }, ...v.buttons.map((b) => button(b, b.action, x, () => x.onAction?.(b.action)))) : null,
    v.error ? h('p', { className: 'pc-err', role: 'alert' }, v.error) : null,
  )
}
