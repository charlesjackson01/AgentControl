import fs from 'node:fs'
import path from 'node:path'
import { test as base, expect, type Locator, type Page } from '@playwright/test'

/** Fake runner origin. Playwright starts it; the Vite proxy forwards /api here. */
export const FAKE_ORIGIN = 'http://127.0.0.1:3099'
const APP_ORIGIN = 'http://127.0.0.1:4174'

export type Scene = 'mac' | 'linux' | 'windows'

const FREEZE = `(() => {
  const fixed = Date.parse('2026-11-06T15:00:00.000Z')
  const NativeDate = Date
  function PatchedDate(...args) {
    if (!new.target) return new NativeDate(fixed).toString()
    if (args.length === 0) return new NativeDate(fixed)
    return new NativeDate(...args)
  }
  PatchedDate.now = () => fixed
  PatchedDate.parse = NativeDate.parse
  PatchedDate.UTC = NativeDate.UTC
  PatchedDate.prototype = NativeDate.prototype
  window.Date = PatchedDate
  try {
    localStorage.setItem('agentcontrol.theme', 'light')
    localStorage.setItem('agentcontrol.chatList.open', '0')
  } catch {
    /* private mode: the suite still locks timezone and viewport in the config */
  }
})()`

async function resetWorld(): Promise<void> {
  const res = await fetch(`${FAKE_ORIGIN}/__e2e/reset`, { method: 'POST' })
  if (!res.ok) throw new Error(`fake runner reset failed: ${res.status}`)
}

export const test = base.extend({
  page: async ({ page }, run) => {
    await resetWorld()
    await page.addInitScript(FREEZE)
    await run(page)
  },
})

export { expect }

/** Open a route against one host scene. mac is the default cookie. `idle` hides in-progress runs. */
export async function openApp(page: Page, route: string, scene: Scene = 'mac', opts?: { idle?: boolean }): Promise<void> {
  await page.context().clearCookies()
  const cookies: { name: string; value: string; url: string }[] = [{ name: 'ac-e2e-scene', value: scene, url: APP_ORIGIN }]
  if (opts?.idle) cookies.push({ name: 'ac-e2e-runs', value: 'idle', url: APP_ORIGIN })
  await page.context().addCookies(cookies)
  await page.goto(route)
}

/** Account menu → Settings, then the VMs section. The chat underneath stays quiet when `idle` is set. */
export async function openVms(page: Page, scene: Scene): Promise<void> {
  await openApp(page, '/c/dm-analyst', scene, { idle: true })
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Profile & endpoints' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'VMs', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'Machine', exact: true })).toBeVisible()
}

/**
 * Save a PNG under e2e/artifacts and attach it to the report.
 * Pixel diffs are not a pass/fail gate (M3 plan risk table): nothing here calls toHaveScreenshot.
 */
export async function shot(target: Page | Locator, name: string): Promise<void> {
  const dir = path.join('e2e', 'artifacts')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await target.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
  await test.info().attach(name, { path: file, contentType: 'image/png' })
}
