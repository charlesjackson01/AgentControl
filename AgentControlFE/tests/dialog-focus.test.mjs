import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { FOCUSABLE_SELECTOR, initialFocus, restoreTarget, rowFocusTarget, shouldRestore, tabTarget } from '../src/lib/dialog-focus.ts'
import { createDialogStack } from '../src/lib/dialog-stack.ts'

const panel = { name: 'panel' }
const close = { name: 'close' }, nameInput = { name: 'name' }, save = { name: 'save' }
const items = [close, nameInput, save]

describe('dialog focus: on open', () => {
  it('prefers [data-autofocus]', () => {
    assert.equal(initialFocus(nameInput, items, panel), nameInput)
  })
  it('falls back to the first focusable element', () => {
    assert.equal(initialFocus(null, items, panel), close)
    assert.equal(initialFocus(undefined, items, panel), close)
  })
  it('falls back to the panel itself when nothing inside can take focus', () => {
    assert.equal(initialFocus(null, [], panel), panel)
  })
})

describe('dialog focus: Tab trap', () => {
  it('Tab from the last element wraps to the first; Shift+Tab from the first wraps to the last', () => {
    assert.equal(tabTarget(items, save, true, false, panel), close)
    assert.equal(tabTarget(items, close, true, true, panel), save)
  })
  it('Tab in the middle is left to the browser', () => {
    assert.equal(tabTarget(items, nameInput, true, false, panel), null)
    assert.equal(tabTarget(items, nameInput, true, true, panel), null)
    assert.equal(tabTarget(items, close, true, false, panel), null)
    assert.equal(tabTarget(items, save, true, true, panel), null)
  })
  it('focus outside the panel (the trigger behind it, <body>) is pulled back in', () => {
    const trigger = { name: 'Edit button in Settings' }
    assert.equal(tabTarget(items, trigger, false, false, panel), close)
    assert.equal(tabTarget(items, trigger, false, true, panel), save)
    assert.equal(tabTarget(items, null, false, false, panel), close)
  })
  it('from the panel itself (tabindex=-1 fallback) Tab goes in at either end', () => {
    assert.equal(tabTarget(items, panel, true, false, panel), close)
    assert.equal(tabTarget(items, panel, true, true, panel), save)
  })
  it('an empty panel keeps focus on itself', () => {
    assert.equal(tabTarget([], panel, true, false, panel), panel)
    assert.equal(tabTarget([], { name: 'outside' }, false, true, panel), panel)
  })
  it('a single focusable element wraps onto itself', () => {
    assert.equal(tabTarget([close], close, true, false, panel), close)
    assert.equal(tabTarget([close], close, true, true, panel), close)
  })
  it('a focused tabindex=-1 node inside the panel is left to the browser', () => {
    assert.equal(tabTarget(items, { name: 'tabindex=-1 node' }, true, false, panel), null)
  })
})

describe('dialog focus: on close', () => {
  const trigger = { name: 'trigger' }, settingsPanel = { name: 'settings panel' }
  it('returns focus to the opener while it is still in the document', () => {
    assert.equal(restoreTarget(trigger, true, settingsPanel), trigger)
    assert.equal(restoreTarget(trigger, true, null), trigger)
  })
  it('a removed opener (deleted endpoint row) falls back to the dialog underneath', () => {
    assert.equal(restoreTarget(trigger, false, settingsPanel), settingsPanel)
    assert.equal(restoreTarget(null, false, settingsPanel), settingsPanel)
  })
  it('a removed opener (⋯ menu item) uses the dialog\'s returnFocus fallback before the panel below', () => {
    const rowBtn = { name: 'row ⋯' }
    assert.equal(restoreTarget(trigger, false, settingsPanel, rowBtn), rowBtn)
    assert.equal(restoreTarget(null, false, null, rowBtn), rowBtn)
    assert.equal(restoreTarget(trigger, false, settingsPanel, null), settingsPanel, 'no row found: panel below')
    assert.equal(restoreTarget(trigger, true, settingsPanel, rowBtn), trigger, 'a live opener still wins')
  })
  it('nothing to restore when the opener is gone and no dialog is left', () => {
    assert.equal(restoreTarget(trigger, false, undefined), null)
    assert.equal(restoreTarget(null, false, null), null)
  })
  it('only restores when focus would be lost, and only from the top dialog', () => {
    assert.equal(shouldRestore(true, false, true), true, 'focus fell to <body>')
    assert.equal(shouldRestore(false, true, true), true, 'focus still in the closing panel')
    assert.equal(shouldRestore(false, false, true), false, 'user already moved focus elsewhere')
    assert.equal(shouldRestore(true, false, false), false, 'a lower dialog closing under the top one')
  })
})

describe('dialog focus: nested dialogs via the stack', () => {
  it('closing the top dialog makes the one underneath top, and top() exposes it for restore', () => {
    const s = createDialogStack()
    const settings = { panel: () => 'settings' }, edit = { panel: () => 'edit' }
    assert.equal(s.top(), undefined)
    s.open(settings); s.open(edit)
    assert.equal(s.top(), edit)
    assert.equal(s.isTop(settings), false, 'only the top dialog traps Tab')
    s.close(edit)
    assert.equal(s.top(), settings)
    assert.equal(restoreTarget(null, false, s.top().panel()), 'settings')
  })
})

describe('dialog focus: wiring', () => {
  it('the selector covers the usual focusables', () => {
    for (const sel of ['a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]']) {
      assert.ok(FOCUSABLE_SELECTOR.includes(sel), sel)
    }
  })
  it('useDialogFocus uses the helpers and restores on close', () => {
    const src = readFileSync(new URL('../src/hooks/useDialogFocus.ts', import.meta.url), 'utf8')
    assert.match(src, /initialFocus\(/)
    assert.match(src, /tabTarget\(/)
    assert.match(src, /restoreTarget\(/)
    assert.match(src, /dialogStack\.top\(\)/)
    assert.match(src, /if \(open\) setOpener\(activeElement\(\)\)/, 'opener is captured in the render that opens the dialog')
    assert.match(src, /e\.stopPropagation\(\)\s*\n\s*onCloseRef\.current\(\)/, 'Esc stops at the top dialog')
  })
  for (const file of ['Dialog.tsx', 'ConfirmDialog.tsx']) {
    it(`${file} uses useDialogFocus, a focusable panel and a backdrop that does not blur`, () => {
      const src = readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8')
      assert.match(src, /useDialogFocus\(open, panelRef, /)
      assert.match(src, /tabIndex=\{-1\}/)
      assert.match(src, /e\.preventDefault\(\)\s*\n\s*on(Close|Cancel)\(\)/, 'a backdrop press must not blur to <body> after focus was restored')
      assert.doesNotMatch(src, /addEventListener\('keydown'/, 'no separate Esc/Tab handler outside the stack')
      assert.doesNotMatch(src, /\.focus\(\)/, 'no separate focus code')
      assert.doesNotMatch(src, /body\.style\.overflow/, 'scroll lock lives in the hook')
    })
  }
  it('ConfirmDialog autofocuses Cancel, not the panel', () => {
    const src = readFileSync(new URL('../src/components/ConfirmDialog.tsx', import.meta.url), 'utf8')
    assert.match(src, /className="btn"\s*\n\s*data-autofocus\s*\n\s*onClick=\{onCancel\}/)
    assert.equal((src.match(/data-autofocus/g) || []).length, 1)
  })
  it('the bot settings slide-over ignores Esc while a dialog is open', () => {
    const src = readFileSync(new URL('../src/components/settings/BotSettingsPanel.tsx', import.meta.url), 'utf8')
    assert.match(src, /e\.key === 'Escape' && !e\.defaultPrevented && !document\.querySelector\('\.dialog-backdrop/)
  })
  it('the endpoint dialog focuses Name (edit/new) and Cancel (delete)', () => {
    const src = readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8')
    assert.match(src, /<input id="ep-name" data-autofocus/)
    assert.match(src, /className="btn" data-autofocus onClick=\{\(\) => setDialog\(null\)\}/)
  })
})

describe('dialog focus: back to the row after a ⋯ menu Rename/Delete', () => {
  const list = { name: 'file list' }
  const btn = (k) => ({ name: `⋯ ${k}` })
  const rows = (...keys) => keys.map((key) => ({ key, el: btn(key) }))
  it('same row (Esc / Cancel): its own ⋯ button', () => {
    const r = rows('shared/a.txt', 'shared/b.txt', 'shared/c.txt')
    assert.equal(rowFocusTarget(r, 'shared/b.txt', 1, list), r[1].el)
  })
  it('renamed row: found by its new path, wherever the sort put it', () => {
    const r = rows('shared/a.txt', 'shared/c.txt', 'shared/z-renamed.txt')
    assert.equal(rowFocusTarget(r, 'shared/z-renamed.txt', 0, list), r[2].el)
  })
  it('deleted row: the next row (now at its index), else the previous, else the list', () => {
    const r = rows('shared/a.txt', 'shared/c.txt')
    assert.equal(rowFocusTarget(r, 'shared/b.txt', 1, list), r[1].el, 'next row moved into its place')
    assert.equal(rowFocusTarget(r, 'shared/d.txt', 2, list), r[1].el, 'was last: previous row')
    assert.equal(rowFocusTarget([], 'shared/a.txt', 0, list), list, 'list now empty')
    assert.equal(rowFocusTarget([], 'shared/a.txt', 0, null), null)
  })
  it('a row without a ⋯ button (read-only) is skipped to the list rather than null', () => {
    assert.equal(rowFocusTarget([{ key: 'k', el: null }], 'gone', 0, list), list)
  })
  it('wired: Dialog/ConfirmDialog take returnFocus; FilesTab passes the row fallback', () => {
    const hook = readFileSync(new URL('../src/hooks/useDialogFocus.ts', import.meta.url), 'utf8')
    assert.match(hook, /returnFocusRef\.current\?\.\(\)/)
    const tab = readFileSync(new URL('../src/components/settings/FilesTab.tsx', import.meta.url), 'utf8')
    assert.match(tab, /rowFocusTarget\(/)
    assert.match(tab, /returnFocus=\{menuReturnFocus\}/)
  })
})
