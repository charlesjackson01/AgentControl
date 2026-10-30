import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/* Regression guards for shell.css layout rules that unit tests can't otherwise see. */
const css = readFileSync(new URL('../src/shell.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(m, `${selector} rule exists`)
  return Object.fromEntries(
    m[1].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const i = d.indexOf(':')
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()]
    }),
  )
}

describe('thread layout', () => {
  it('.cf-thread is the scroller (flex column, overflow auto)', () => {
    const t = rule('.cf-thread')
    assert.equal(t['overflow-y'], 'auto')
    assert.equal(t.display, 'flex')
    assert.equal(t['flex-direction'], 'column')
  })
  it('.cf-thread__inner never shrinks to the viewport (else long chats cannot scroll up and ?m cannot scroll)', () => {
    const inner = rule('.cf-thread__inner')
    const shrink = inner['flex-shrink'] ?? (inner.flex === 'none' ? '0' : inner.flex?.split(/\s+/)[1])
    assert.equal(shrink, '0', 'flex-shrink: 0 (or flex: none) on .cf-thread__inner')
    assert.equal(inner['min-height'], '100%', 'still fills the scroller so short chats sit at the bottom')
    assert.equal(inner['justify-content'], 'flex-end')
  })
})

describe('FE-9 markdown in replies', () => {
  it('lists get markers back (the global ul reset removes them)', () => {
    assert.equal(rule('ul.cf-md__list')['list-style'], 'disc')
    assert.equal(rule('ol.cf-md__list')['list-style'], 'decimal')
  })
  it('code blocks keep whitespace and scroll sideways instead of widening the bubble', () => {
    const pre = rule('.cf-md__pre')
    assert.equal(pre['white-space'], 'pre')
    assert.equal(pre['overflow-x'], 'auto')
  })
  it('the block reset is zero-specificity (:where) so the 8px sibling gap wins', () => {
    assert.equal(rule('.cf-md :where(p, pre, ul, ol)').margin, '0')
  })
})

describe('FE-8 phone layouts stay below 760 px', () => {
  /* Map each top-level rule to the @media it sits in (null = none). */
  function rulesWithMedia(src) {
    const out = []
    let i = 0, media = null, depth = 0, start = 0
    while (i < src.length) {
      const c = src[i]
      if (c === '{') {
        const head = src.slice(start, i).trim()
        if (depth === 0 && head.startsWith('@media')) media = head
        else out.push({ selector: head, media: depth > 0 ? media : null, body: src.slice(i + 1, src.indexOf('}', i)) })
        depth++; start = i + 1
      } else if (c === '}') {
        depth--; if (depth === 0) media = null
        start = i + 1
      } else if (c === ';' && depth === 0) start = i + 1
      i++
    }
    return out
  }
  const rules = rulesWithMedia(css)

  it('every phone-only rule is inside @media (max-width: 759px)', () => {
    const phone = rules.filter((r) => /\.cf-mlist|\.cf-mhdr|\.cf-cbtn--skills/.test(r.selector))
    assert.ok(phone.length > 10, 'FE-8 rules found')
    for (const r of phone) assert.equal(r.media, '@media (max-width: 759px)', r.selector)
  })
  it('05b hides (bot avatars in the thread, ✦ and the hint) only on phones', () => {
    const hides = rules.filter((r) => /display:\s*none/.test(r.body) && /\.cf-row__av|\.cf-cbtn--skills/.test(r.selector))
    assert.ok(hides.some((r) => r.selector === '.cf-row__av'), '.cf-row__av hidden')
    assert.ok(hides.some((r) => r.selector.includes('.cf-cbtn--skills')), '✦ hidden')
    for (const r of hides) assert.equal(r.media, '@media (max-width: 759px)', r.selector)
  })
  it('the old narrow drawer rule is gone (05a replaces it with the list screen)', () => {
    assert.ok(!rules.some((r) => r.selector === '.cf-shell--narrow .cf-side'))
  })
})

describe('FE-P2-7 new-bot browser row (mockup 15)', () => {
  it('.cf-nb-row3 is text left, switch right, top-aligned', () => {
    const r = rule('.cf-nb-row3')
    assert.equal(r.display, 'flex')
    assert.equal(r['align-items'], 'flex-start')
    assert.equal(r['margin-top'], '12px')
    assert.equal(rule('.cf-nb-row3__t').flex, '1')
    assert.equal(rule('.cf-nb-row3 .cf-toggle').flex, 'none')
  })
  it('GAP6: at phone width the NewBot card fills the row (beats the 05b .cf-grp 80% cap)', () => {
    const m = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)
    assert.ok(m, 'the NewBot 640px block exists')
    const r = /\.cf-grp\.cf-nb-grp\s*\{([^}]*)\}/.exec(m[1])
    assert.ok(r, '.cf-grp.cf-nb-grp (two classes, so it outranks .cf-grp) is in the 640px block')
    assert.match(r[1], /width:\s*100%/)
    assert.match(r[1], /max-width:\s*none/)
  })
})
