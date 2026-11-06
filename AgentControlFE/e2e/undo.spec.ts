import { expect, openApp, shot, test } from './support'

/**
 * Undo of a run that still has a snapshot, and the eviction reason on a run whose
 * snapshot was removed to stay inside the bot's undo budget (budget_bot).
 */
test('undo dialog reverses a run, and an evicted run says why', async ({ page }) => {
  await openApp(page, '/c/dm-analyst')

  const evicted = page.locator('[data-run-id="run-evicted"]')
  await evicted.locator('.rc-head').click()
  await expect(evicted.getByText("Undo no longer available: removed to stay within Analyst's undo space.")).toBeVisible()
  await expect(evicted.getByRole('button', { name: 'Undo run' })).toHaveCount(0)
  await shot(evicted, 'undo-evicted')

  const ok = page.locator('[data-run-id="run-ok"]')
  await ok.locator('.rc-head').click()
  await ok.getByRole('button', { name: 'Undo run' }).click()

  const dialog = page.getByRole('dialog', { name: 'Undo this run?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('workspace/week.csv')).toBeVisible()
  await expect(dialog.getByText(/can't take back anything a script sent over the internet/)).toBeVisible()
  const confirm = dialog.getByRole('button', { name: 'Undo run' })
  await expect(confirm).toBeEnabled()
  await shot(dialog, 'undo-dialog')
  await confirm.click()

  await expect(dialog).toBeHidden()
  await expect(ok.locator('.rc')).toHaveAttribute('data-status', 'undone')
  await expect(ok.getByText('Undone', { exact: true })).toBeVisible()
  await shot(ok, 'undo-done')
})
