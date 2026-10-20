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
