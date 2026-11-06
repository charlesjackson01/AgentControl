import { expect, openVms, shot, test } from './support'

/**
 * Settings › VMs (FE-P2-6), loaded through the fake /api routes. VITE_VMS_FAKE is left unset.
 */
test('Mac Settings › VMs shows machine, gVisor, budgets, backups and downloads', async ({ page }) => {
  await openVms(page, 'mac')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('button', { name: 'VMs' })).toHaveAttribute('aria-current', 'page')
  await expect(settings.getByRole('heading', { name: 'Machine' })).toBeVisible()
  await expect(settings.getByText('agentcontrol · Podman machine on this Mac (libkrun) · 6 GB RAM · 4 vCPU')).toBeVisible()
  await expect(settings.getByText('23 of 60 GB used')).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Grow to 90 GB...' })).toBeEnabled()
  await expect(settings.getByRole('heading', { name: 'gVisor (global)' })).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true')
  await expect(settings.getByRole('button', { name: 'Re-check now' })).toBeVisible()
  await expect(settings.getByLabel('Per bot (MB)')).toHaveValue('2048')
  await expect(settings.getByLabel('Global (MB)')).toHaveValue('15360')
  await expect(settings.getByLabel('Free-floor (MB)')).toHaveValue('5120')
  await expect(settings.getByText('Time 03:00 · Keep last 7')).toBeVisible()
  await expect(settings.getByText('Nightly · Analyst')).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Back up now' })).toBeVisible()
  await expect(settings.getByText('botvm-browser')).toBeVisible()
  await expect(settings.getByText('Windows — bot files live inside the Podman machine')).toHaveCount(0)
  await shot(settings, 'vms-page-mac')

  await settings.getByRole('button', { name: 'Restore…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Restore backup?' })
  await expect(confirm.getByText(/reason: machine restored/)).toBeVisible()
  await shot(confirm, 'vms-restore-confirm')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toBeHidden()
})

test("a restore that fails a bot's tools shows the message under the list", async ({ page }) => {
  await openVms(page, 'mac')
  // openVms clears cookies first. Path must be `/` so the restore POST to /api carries this.
  await page.context().addCookies([{ name: 'ac-e2e-restore', value: 'tools-fail', url: 'http://127.0.0.1:4174' }])
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Restore…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Restore backup?' })
  await confirm.getByRole('button', { name: 'Restore backup' }).click()
  await expect(confirm).toBeHidden()
  const note = settings.getByRole('alert').filter({ hasText: "Analyst: the tool rebuild didn't start (libssl missing)." })
  await expect(note).toBeVisible()
  await shot(settings, 'vms-restore-tools-failed')
})

test('Linux Settings › VMs has no machine disk to grow', async ({ page }) => {
  await openVms(page, 'linux')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByText('Bots run on this Linux computer. There is no Podman machine disk to grow.')).toBeVisible()
  await expect(settings.getByRole('button', { name: /Grow to/ })).toHaveCount(0)
  await shot(settings, 'vms-page-linux')
})

test('Windows Settings › VMs shows the data-loss warning', async ({ page }) => {
  await openVms(page, 'windows')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'Windows — bot files live inside the Podman machine' })).toBeVisible()
  await expect(settings.getByText(/podman machine rm \/ reset or WSL unregister/)).toBeVisible()
  await expect(settings.getByText('Windows path: %LOCALAPPDATA%\\AgentControl\\backups\\<date>\\')).toBeVisible()
  await expect(settings.getByText(/Podman machine on Windows \(WSL2\)/)).toBeVisible()
  await shot(settings, 'vms-page-windows')
})
