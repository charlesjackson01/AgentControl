/**
 * FE-9: a safe markdown subset for assistant replies. Pure (no React, no DOM),
 * so tests/markdown.test.mjs can import it.
 *
 * Supported: **bold** / __bold__, *italic* / _italic_, `inline code`, fenced
 * ``` / ~~~ code blocks, ordered and unordered lists (nesting by indentation),
 * [links](https://…), bare http(s) URLs, backslash escapes, and line breaks.
 * Everything else (headings, tables, quotes, images, raw HTML) stays literal
 * text. Nothing here produces HTML: the result is an AST that
 * markdown-render.ts turns into React elements, so `<script>` and friends are
 * only ever text nodes. Only http(s): and mailto: hrefs survive (`safeHref`).
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] }
  | { type: 'br' }

export type MdBlock =
  | { type: 'paragraph'; children: MdInline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: MdBlock[][] }

/** Bounds for hostile input: nesting depth and the size we bother to parse. */
const MAX_DEPTH = 8
export const MAX_MARKDOWN_CHARS = 100_000

// ---------------------------------------------------------------------------
// Links

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: '\u00a0',
  sol: '/', lpar: '(', rpar: ')', period: '.', num: '#', excl: '!', percnt: '%', equals: '=',
}

/** Decode HTML character references the way a browser would (also without `;`), repeatedly. */
function decodeEntities(s: string): string {
  let prev = ''
  let out = s
  for (let i = 0; i < 5 && out !== prev; i++) {
    prev = out
    out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, body: string) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? m
    })
  }
  return out
}

/** Also percent-decoded once, so `%6Aavascript:` can't hide a scheme from the check. */
function percentDecoded(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

// Control characters, all whitespace, zero-width and bidi marks: browsers strip
// or ignore several of these inside a scheme ("java\tscript:").
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g

/**
 * The href to render, or null when the link must be inert. Only absolute
 * http:, https: and mailto: URLs pass; the scheme check runs after decoding
 * entities and percent-escapes and dropping whitespace/control characters, so
 * mixed-case, entity-encoded and whitespace-split `javascript:` (and `data:`,
 * `vbscript:`, `file:` …) are all refused. Relative URLs are refused too: a
 * bot reply has no meaningful base.
 */
export function safeHref(raw: string): string | null {
  const decoded = decodeEntities(raw).replace(INVISIBLE, '')
  const probe = percentDecoded(decoded).replace(INVISIBLE, '').toLowerCase()
  if (!/^(https?:\/\/|mailto:)/.test(probe)) return null
  if (/^mailto:/i.test(decoded)) {
    return decoded.length > 'mailto:'.length && !/[<>"'`]/.test(decoded) ? `mailto:${decoded.slice(7)}` : null
  }
  let url: URL
  try { url = new URL(decoded) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.href
}

// ---------------------------------------------------------------------------
// Inline

/** Link label / destination scan limits, so runs of "[" or "(" can't make parsing quadratic. */
const MAX_LABEL = 1000
const MAX_DEST = 4096

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|<>~"'&]/
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/i

function pushText(out: MdInline[], text: string) {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.type === 'text') last.text += text
  else out.push({ type: 'text', text })
}

/** Index of the `]` matching the `[` at `open`, or -1. */
function matchBracket(s: string, open: number): number {
  let depth = 0
  for (let i = open, end = Math.min(s.length, open + MAX_LABEL); i < end; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0]
      const close = s.indexOf(run, i + run.length)
      if (close > 0) { i = close + run.length - 1; continue }
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i
  }
  return -1
}

/** Index of the `)` matching the `(` at `open` (balanced), or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0
  for (let i = open, end = Math.min(s.length, open + MAX_DEST); i < end; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '\n' && s[i + 1] === '\n') return -1
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return -1
}

/** Closing emphasis delimiter for `delim` opened at `from`: not after whitespace; `_` not intraword. */
function findCloser(s: string, from: number, delim: string, misses: Map<string, number>): number {
  // A search that found nothing from `p` finds nothing from any later start either
  // (closers don't depend on the opener), so runs of unclosed openers stay linear.
  if (from >= (misses.get(delim) ?? Infinity)) return -1
  for (let i = from; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') { i++; continue }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0]
      const close = s.indexOf(run, i + run.length)
      if (close > 0) { i = close + run.length - 1; continue }
    }
    if (s.startsWith(delim, i) && i > from && !/\s/.test(s[i - 1]!)) {
      // `**a**b` with `*`: skip a `*` that is part of a `**` run.
      if (delim.length === 1 && (s[i + 1] === delim || s[i - 1] === delim)) continue
      if (delim[0] === '_' && /\w/.test(s[i + delim.length] ?? '')) continue
      return i
    }
  }
  misses.set(delim, Math.min(from, misses.get(delim) ?? Infinity))
  return -1
}

function parseInline(s: string, depth: number, inLink = false): MdInline[] {
  const out: MdInline[] = []
  if (depth > MAX_DEPTH) { pushText(out, s); return out }
  const misses = new Map<string, number>()
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    const rest = s.slice(i)

    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1]!
      if (next === '\n') { out.push({ type: 'br' }); i += 2; continue }
      if (ESCAPABLE.test(next)) { pushText(out, next); i += 2; continue }
    }

    if (c === '\n') { out.push({ type: 'br' }); i++; continue }

    if (c === '`') {
      const run = /^`+/.exec(rest)![0]
      const close = s.indexOf(run, i + run.length)
      // A longer backtick run is not a closer for a shorter one.
      if (close > 0 && s[close + run.length] !== '`') {
        let text = s.slice(i + run.length, close).replace(/\n/g, ' ')
        if (/^ .* $/.test(text) && text.trim()) text = text.slice(1, -1)
        out.push({ type: 'code', text })
        i = close + run.length
        continue
      }
      pushText(out, run); i += run.length; continue
    }

    if (c === '*' || c === '_') {
      const prevWord = c === '_' && i > 0 && /\w/.test(s[i - 1]!)
      const triple = c.repeat(3)
      if (!prevWord && s.startsWith(triple, i) && s[i + 3] !== c && s[i + 3] !== undefined && !/\s/.test(s[i + 3]!)) {
        const close = s.indexOf(triple, i + 3)
        if (close > i + 3 && !/\s/.test(s[close - 1]!) && s[close + 3] !== c) {
          out.push({ type: 'strong', children: [{ type: 'em', children: parseInline(s.slice(i + 3, close), depth + 1, inLink) }] })
          i = close + 3
          continue
        }
      }
      const delim = s[i + 1] === c ? c + c : c
      const after = s[i + delim.length]
      if (!prevWord && after !== undefined && !/\s/.test(after)) {
        const close = findCloser(s, i + delim.length, delim, misses)
        if (close > 0) {
          const children = parseInline(s.slice(i + delim.length, close), depth + 1, inLink)
          out.push(delim.length === 2 ? { type: 'strong', children } : { type: 'em', children })
          i = close + delim.length
          continue
        }
      }
      pushText(out, delim); i += delim.length; continue
    }

    if (c === '[' && !inLink) {
      const close = matchBracket(s, i)
      if (close > 0 && s[close + 1] === '(') {
        const end = matchParen(s, close + 1)
        if (end > 0) {
          const label = s.slice(i + 1, close)
          // Destination plus an optional "title" (dropped). Whitespace inside the
          // destination is kept here and stripped by safeHref, so "java script:" is still caught.
          const dest = s.slice(close + 2, end).trim().replace(/\s+("[^"]*"|'[^']*')$/, '').replace(/^<(.*)>$/s, '$1')
          const href = safeHref(dest)
          const children = parseInline(label, depth + 1, true)
          if (href) out.push({ type: 'link', href, children })
          else {
            // GAP-M4: a refused link renders as its label, plain text (no URL, no styling).
            for (const ch of children) {
              if (ch.type === 'text') pushText(out, ch.text)
              else out.push(ch)
            }
          }
          i = end + 1
          continue
        }
      }
    }

    if (!inLink && (c === 'h' || c === 'H') && (i === 0 || /[\s(]/.test(s[i - 1]!))) {
      const m = BARE_URL.exec(rest)
      if (m) {
        // Trailing punctuation belongs to the sentence; an unbalanced ")" too.
        let url = m[0].replace(/[.,;:!?*_~]+$/, '')
        while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
        const href = safeHref(url)
        if (href) { out.push({ type: 'link', href, children: [{ type: 'text', text: url }] }); i += url.length; continue }
      }
    }

    // Plain run up to the next special character.
    const m = /^[^\\\n`*_[hH]+/.exec(rest)
    const take = m ? m[0] : c
    pushText(out, take)
    i += take.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/
const BULLET = /^( {0,3})([-*+])([ \t]+)(.*)$/
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/

type ItemStart = { ordered: boolean; marker: string; start: number; contentIndent: number; first: string }

function itemStart(line: string): ItemStart | null {
  const b = BULLET.exec(line)
  if (b) return { ordered: false, marker: b[2]!, start: 1, contentIndent: b[1]!.length + 1 + Math.min(b[3]!.length, 4), first: b[4]! }
  const o = ORDERED.exec(line)
  if (o) return { ordered: true, marker: o[3]!, start: Number(o[2]), contentIndent: o[1]!.length + o[2]!.length + 1 + Math.min(o[4]!.length, 4), first: o[5]! }
  return null
}

const indentOf = (line: string) => /^[ \t]*/.exec(line)![0].replace(/\t/g, '    ').length
const isBlank = (line: string) => line.trim() === ''

function dedent(line: string, n: number): string {
  let i = 0
  let col = 0
  while (i < line.length && col < n && (line[i] === ' ' || line[i] === '\t')) { col += line[i] === '\t' ? 4 : 1; i++ }
  return line.slice(i)
}

function parseLines(lines: string[], depth: number): MdBlock[] {
  const blocks: MdBlock[] = []
  if (depth > MAX_DEPTH) {
    const text = lines.join('\n').trim()
    if (text) blocks.push({ type: 'paragraph', children: [{ type: 'text', text }] })
    return blocks
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (isBlank(line)) { i++; continue }

    const fence = FENCE.exec(line)
    if (fence) {
      const mark = fence[1]!
      const indent = indentOf(line)
      const body: string[] = []
      i++
      while (i < lines.length) {
        const l = lines[i]!
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l)
        if (close && close[1]![0] === mark[0] && close[1]!.length >= mark.length) { i++; break }
        body.push(dedent(l, indent))
        i++
      }
      blocks.push({ type: 'code', lang: fence[2]!.replace(/[^\w+#.-]/g, '').slice(0, 32), text: body.join('\n') })
      continue
    }

    const first = itemStart(line)
    if (first) {
      const items: MdBlock[][] = []
      let cur: ItemStart | null = first
      while (cur) {
        const itemLines = [cur.first]
        i++
        while (i < lines.length) {
          const l = lines[i]!
          if (isBlank(l)) {
            // A blank line continues the item only if indented content follows.
            const next = lines.slice(i + 1).find((x) => !isBlank(x))
            if (next !== undefined && indentOf(next) >= cur.contentIndent) { itemLines.push(''); i++; continue }
            break
          }
          if (indentOf(l) >= cur.contentIndent) { itemLines.push(dedent(l, cur.contentIndent)); i++; continue }
          if (itemStart(l) || FENCE.test(l)) break
          itemLines.push(l.trimStart()) // lazy continuation of the item's paragraph
          i++
        }
        items.push(parseLines(itemLines, depth + 1))
        // Same kind of list continues, across at most one blank run.
        let j = i
        while (j < lines.length && isBlank(lines[j]!)) j++
        const next: ItemStart | null = j < lines.length ? itemStart(lines[j]!) : null
        if (next && next.ordered === first.ordered && next.marker === first.marker && indentOf(lines[j]!) < first.contentIndent) {
          i = j
          cur = next
        } else cur = null
      }
      blocks.push({ type: 'list', ordered: first.ordered, start: first.start, items })
      continue
    }

    const para: string[] = []
    while (i < lines.length && !isBlank(lines[i]!) && !(para.length && (FENCE.test(lines[i]!) || itemStart(lines[i]!)))) {
      para.push(lines[i]!.replace(/^[ \t]+/, ''))
      i++
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n').replace(/[ \t]+$/gm, ''), 0) })
  }
  return blocks
}

/** Parse a reply into blocks. Over-long input is not parsed (one plain paragraph). */
export function parseMarkdown(markdown: string): MdBlock[] {
  const text = markdown.replace(/\r\n?/g, '\n').replaceAll('\u0000', '\ufffd')
  if (text.length > MAX_MARKDOWN_CHARS) return text.trim() ? [{ type: 'paragraph', children: [{ type: 'text', text }] }] : []
  return parseLines(text.split('\n'), 0)
}
