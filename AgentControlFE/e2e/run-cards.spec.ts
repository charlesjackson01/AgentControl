import { expect, openApp, shot, test } from './support'

/**
 * Run cards plus the internet and browser permission cards, against the fake runner.
 */
test('shows a finished run and both permission cards', async ({ page }) => {
  await openApp(page, '/c/dm-analyst')

  const internet = page.getByRole('group', { name: 'internet permission' })
  const browser = page.getByRole('group', { name: 'browser permission' })
  await expect(internet).toBeVisible()
  await expect(browser).toBeVisible()
  await expect(internet.getByText('Analyst wants to use the internet')).toBeVisible()
  await expect(internet.getByRole('button', { name: 'Allow once' })).toBeVisible()
  await expect(internet.getByRole('button', { name: 'Always for Analyst' })).toBeVisible()
  await expect(internet.getByRole('button', { name: 'Deny' })).toBeVisible()
  await expect(internet.getByText('api.frankfurter.app')).toBeVisible()
  await expect(browser.getByText('Analyst wants to use a browser')).toBeVisible()
  await expect(browser.getByRole('button', { name: 'Turn on browser for Analyst' })).toBeVisible()
  await expect(page.locator('[data-run-id="run-net"]')).toContainText('fetch_rates.py')
  await expect(page.locator('[data-run-id="run-browser"]')).toContainText('snap_dashboard.py')
  await expect(page.locator('[data-run-id="run-ok"]')).toContainText('chart_week.py')
  await expect(page.locator('[data-run-id="run-net"]').locator('.rc')).toHaveAttribute('data-status', 'waiting_permission')

  await shot(page, 'run-cards')
  await shot(internet, 'internet-permission')
  await shot(browser, 'browser-permission')

  await internet.getByRole('button', { name: 'Allow once' }).click()
  await expect(internet.getByText('Internet allowed for')).toBeVisible()
  await expect(internet.getByText('Allowed once')).toBeVisible()
  await shot(internet, 'internet-allowed')
})
