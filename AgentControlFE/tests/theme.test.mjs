import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { THEME_KEY, createThemeController, parseTheme, resolveTheme } from '../src/lib/theme.ts'

function env({ saved = null, systemDark = false, throwing = false } = {}) {
  const store = new Map(saved == null ? [] : [[THEME_KEY, saved]])
  const fns = new Set()
  return {
    store,
    fns,
    root: { dataset: {} },
    media: {
      matches: systemDark,
      addEventListener: (_t, fn) => fns.add(fn),
      removeEventListener: (_t, fn) => fns.delete(fn),
    },
    storage: {
      getItem: (k) => { if (throwing) throw new Error('blocked'); return store.get(k) ?? null },
      setItem: (k, v) => { if (throwing) throw new Error('blocked'); store.set(k, v) },
    },
    flipSystem(dark) { this.media.matches = dark; fns.forEach((fn) => fn({ matches: dark })) },
  }
}

describe('theme helpers', () => {
  it('parseTheme falls back to system', () => {
    assert.equal(parseTheme('dark'), 'dark')
    assert.equal(parseTheme('light'), 'light')
    assert.equal(parseTheme('system'), 'system')
    assert.equal(parseTheme(null), 'system')
    assert.equal(parseTheme('purple'), 'system')
  })
  it('resolveTheme follows the OS only for system', () => {
    assert.equal(resolveTheme('system', true), 'dark')
    assert.equal(resolveTheme('system', false), 'light')
    assert.equal(resolveTheme('light', true), 'light')
    assert.equal(resolveTheme('dark', false), 'dark')
  })
})

describe('B9: saved theme applies app-wide, not only inside Settings', () => {
  it('paints the saved dark preference as soon as the controller starts', () => {
    const e = env({ saved: 'dark' })
    createThemeController(e)
    assert.equal(e.root.dataset.theme, 'dark')
  })
  it('system preference tracks OS changes', () => {
    const e = env({ saved: 'system', systemDark: false })
    const c = createThemeController(e)
    assert.equal(e.root.dataset.theme, 'light')
    e.flipSystem(true)
    assert.equal(e.root.dataset.theme, 'dark')
    c.set('light')
    e.flipSystem(true)
    assert.equal(e.root.dataset.theme, 'light')
  })
  it('set() persists, repaints and notifies subscribers; dispose detaches', () => {
    const e = env()
    const c = createThemeController(e)
    let n = 0
    const off = c.subscribe(() => n++)
    c.set('dark')
    assert.equal(c.get(), 'dark')
    assert.equal(e.store.get(THEME_KEY), 'dark')
    assert.equal(e.root.dataset.theme, 'dark')
    assert.equal(n, 1)
    c.set('dark')
    assert.equal(n, 1)
    off()
    c.set('light')
    assert.equal(n, 1)
    c.dispose()
    assert.equal(e.fns.size, 0)
  })
  it('blocked storage does not break painting', () => {
    const e = env({ throwing: true })
    const c = createThemeController(e)
    c.set('dark')
    assert.equal(e.root.dataset.theme, 'dark')
  })
  it('main.tsx starts the theme before the first render', () => {
    const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
    const start = main.indexOf('startTheme()')
    assert.ok(start > 0, 'main.tsx must call startTheme()')
    assert.ok(start < main.indexOf('createRoot('), 'startTheme() must run before createRoot')
  })
  it('only the app-level controller writes data-theme (no per-page painting)', () => {
    const hook = readFileSync(new URL('../src/hooks/useTheme.ts', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8')
    for (const src of [hook, settings]) assert.doesNotMatch(src, /dataset\.theme\s*=/)
  })
})
