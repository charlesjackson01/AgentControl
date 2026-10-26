/** FE-6 (06a): @mentions as `span.cf-mention`. Plain .ts (createElement) so tests can render it. */
import { createElement as h, Fragment, type ReactNode } from 'react'
import { mentionParts, type MentionCandidate } from './groups.ts'

export function renderMentions(text: string, candidates: readonly MentionCandidate[], key = 'm'): ReactNode {
  const parts = mentionParts(text, candidates)
  if (!parts.some((p) => p.mention)) return text
  return h(
    Fragment,
    null,
    ...parts.map((p, i) => (p.mention ? h('span', { key: `${key}.${i}`, className: 'cf-mention', 'data-agent': p.mention }, p.text) : h(Fragment, { key: `${key}.${i}` }, p.text))),
  )
}
