/**
 * FE-9: turns the markdown AST (./markdown.ts) into React elements. No
 * dangerouslySetInnerHTML anywhere: every string from the reply is a React
 * text child, so raw HTML in a reply shows as text. Only element types and
 * props chosen here are ever created; a link's href has already passed
 * safeHref (http(s)/mailto only). Plain .ts with createElement (no JSX) so
 * tests/markdown.test.mjs can render it with react-dom/server.
 */
import { createElement as h, Fragment, type ReactNode } from 'react'
import { parseMarkdown, type MdBlock, type MdInline } from './markdown.ts'

/** Links open in a new tab and don't hand the opener or referrer to the target (FE-9). */
export const LINK_PROPS = { target: '_blank', rel: 'noopener noreferrer' } as const

/** FE-6: optional renderer for plain text runs (group @mentions); never sees code. */
export type TextRenderer = (text: string, key: string) => ReactNode
type Opts = { text?: TextRenderer }

function inlines(nodes: MdInline[], key: string, o: Opts = {}): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`
    switch (n.type) {
      case 'text': return h(Fragment, { key: k }, o.text ? o.text(n.text, k) : n.text)
      case 'br': return h('br', { key: k })
      case 'code': return h('code', { key: k, className: 'cf-md__code' }, n.text)
      case 'strong': return h('strong', { key: k }, ...inlines(n.children, k, o))
      case 'em': return h('em', { key: k }, ...inlines(n.children, k, o))
      case 'link': return h('a', { key: k, href: n.href, ...LINK_PROPS, className: 'cf-md__a' }, ...inlines(n.children, k, o))
    }
  })
}

function blocks(nodes: MdBlock[], key: string, tight = false, o: Opts = {}): ReactNode[] {
  return nodes.map((b, i) => {
    const k = `${key}.${i}`
    switch (b.type) {
      case 'paragraph':
        // A tight list item's single paragraph renders without a <p>.
        return tight ? h(Fragment, { key: k }, ...inlines(b.children, k, o)) : h('p', { key: k }, ...inlines(b.children, k, o))
      case 'code':
        // GAP-M1: code blocks aren't in the v3 mockups; a plain sunk panel matching inline code.
        return h('pre', { key: k, className: 'cf-md__pre' }, h('code', { className: b.lang ? `language-${b.lang}` : undefined }, b.text))
      case 'list': {
        // GAP-M2: lists aren't in the v3 mockups; browser markers with a small indent.
        const items = b.items.map((item, j) =>
          h('li', { key: `${k}.${j}` }, ...blocks(item, `${k}.${j}`, item.length === 1 && item[0]!.type === 'paragraph', o)),
        )
        return b.ordered
          ? h('ol', { key: k, className: 'cf-md__list', start: b.start !== 1 ? b.start : undefined }, ...items)
          : h('ul', { key: k, className: 'cf-md__list' }, ...items)
      }
    }
  })
}

/** A reply as React elements: a `div.cf-md` around the rendered blocks. */
export function renderMarkdown(markdown: string, text?: TextRenderer): ReactNode {
  return h('div', { className: 'cf-md' }, ...blocks(parseMarkdown(markdown), 'md', false, { text }))
}
