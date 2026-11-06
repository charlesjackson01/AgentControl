import { expect, openApp, shot, test } from './support'

const tab = '/c/dm-analyst?panel=settings&tab=vm'

test('Mac VM tab shows this Mac and the eviction reason in history', async ({ page }) => {
  await openApp(page, tab, 'mac')
  const panel = page.getByRole('dialog', { name: 'Analyst settings' })
  await expect(panel.getByRole('tab', { name: 'VM' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByText("Analyst's own container · Podman on this Mac (libkrun)")).toBeVisible()
  await expect(panel.getByText('data/bots/analyst')).toBeVisible()
  await expect(panel.getByText('snapshot removed to stay within the 2 GB undo budget')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Open Settings › VMs' })).toBeVisible()
  await shot(panel, 'vm-tab-mac')

  await panel.getByRole('button', { name: 'Open Settings › VMs' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings.getByRole('heading', { name: 'Machine' })).toBeVisible()
  await expect(settings.getByText(/Podman machine on this Mac/)).toBeVisible()
})

test('Linux VM tab has no shared machine disk', async ({ page }) => {
  await openApp(page, tab, 'linux')
  const panel = page.getByRole('dialog', { name: 'Analyst settings' })
  await expect(panel.getByText("Analyst's own container · Podman on this computer")).toBeVisible()
  await expect(panel.getByText('data/bots/analyst')).toBeVisible()
  await expect(panel.getByText('WSL')).toHaveCount(0)
  await expect(panel.getByText('%LOCALAPPDATA%')).toHaveCount(0)
  await shot(panel, 'vm-tab-linux')
})

test('Windows VM tab uses the WSL backend and names the backup path', async ({ page }) => {
  await openApp(page, tab, 'windows')
  const panel = page.getByRole('dialog', { name: 'Analyst settings' })
  await expect(panel.getByText("Analyst's own container · Podman on this PC (WSL)")).toBeVisible()
  const backup = panel.getByText(/%LOCALAPPDATA%\\AgentControl\\backups/)
  await backup.scrollIntoViewIfNeeded()
  await expect(backup).toBeVisible()
  await expect(panel.getByText(/Removing the WSL distro or Podman machine deletes the live files/)).toBeVisible()
  await shot(panel, 'vm-tab-windows')
  await shot(backup, 'vm-tab-windows-backup')
})
