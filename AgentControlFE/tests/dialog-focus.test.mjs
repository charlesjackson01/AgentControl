import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { FOCUSABLE_SELECTOR, initialFocus, restoreTarget, shouldRestore, tabTarget } from '../src/lib/dialog-focus.ts'
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
