import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { internetNeverText } from '../src/lib/run-card.ts'
import { finishLowDiskSentence } from '../src/lib/low-disk.ts'
import { createFakeVmsState, fakeVmsDispatch, resetFakeVms } from '../src/lib/vms-fake.ts'
import { vmsFakeEnabled, vmsRequestWith } from '../src/lib/vms-fallback.ts'
import {
  ACCOUNT_SECTIONS, BACKUP_LIST_ERROR, BUDGET_HINTS, GROW_BUSY_HINT, LOAD_ERROR_TEXT, LOAD_ERROR_TITLE, RESTORE_BODY, VMS_PAGE_GAPS,
  accountSection, backupRow, backupWhen, backupsEmptyText, backupsIntro, budgetErrors, budgetPatch, clockFromHHMM, diskUsedText,
  growButtonLabel, growConfirmBody, growConfirmLabel, growConfirmTitle, gvisorBadge, linuxNativeText, machineSubtitle, probeSummary,
  restoreSubtitle, runsLookActive, scheduleLine, sharedDownloads, windowsWarning,
} from '../src/lib/vms-page.ts'

const NOW = new Date(2026, 10, 6, 16, 0, 0)
const iso = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).toISOString()

describe('Settings › VMs view (FE-P2-6)', () => {
  it('nav order and the dialog title copy', () => {
    assert.deepEqual(ACCOUNT_SECTIONS.map((s) => s.label), ['Profile', 'Endpoints', 'Appearance', 'VMs', 'Runtime', 'Danger'])
    assert.equal(accountSection('vms'), 'vms')
    assert.equal(accountSection('nope'), 'profile')
    assert.equal(accountSection(undefined), 'profile')
  })

  it('dates: Today, Yesterday, Nov 4, 4:12 PM', () => {
    assert.equal(backupWhen(iso(2026, 10, 6, 3, 0), NOW), 'Today, 3:00 AM')
    assert.equal(backupWhen(iso(2026, 10, 5, 3, 0), NOW), 'Yesterday, 3:00 AM')
    assert.equal(backupWhen(iso(2026, 10, 4, 16, 12), NOW), 'Nov 4, 4:12 PM')
    assert.equal(clockFromHHMM('03:00'), '3:00 AM')
    assert.equal(backupsEmptyText('03:00'), 'No backups yet. Nightly runs at 3:00 AM local, or tap Back up now.')
  })

  it('machine, disk, and grow copy', () => {
    const mac = createFakeVmsState('default', NOW)
    assert.equal(machineSubtitle(mac.host), 'agentcontrol · Podman machine on this Mac (libkrun) · 6 GB RAM · 4 vCPU')
    assert.equal(diskUsedText(mac.host), '23 of 60 GB used')
    assert.equal(growButtonLabel(90), 'Grow to 90 GB...')
    assert.equal(growConfirmTitle(90), 'Grow disk to 90 GB?')
    assert.equal(growConfirmLabel(90), 'Grow to 90 GB')
    assert.match(growConfirmBody(90), /can't run while a bot has an active run/)
    assert.equal(GROW_BUSY_HINT, 'Grow is unavailable while a bot has a run in progress.')
    const win = createFakeVmsState('windows', NOW)
    assert.equal(machineSubtitle(win.host), 'agentcontrol · Podman machine on Windows (WSL2) · 6 GB RAM · 4 vCPU')
    const linux = createFakeVmsState('linux', NOW)
    assert.equal(machineSubtitle(linux.host), null)
    assert.equal(linuxNativeText(), 'Bots run on this Linux computer. There is no Podman machine disk to grow.')
  })

  it('gVisor probe lines: version, and idmap plus chromium', () => {
    const mac = createFakeVmsState('default', NOW)
    assert.equal(probeSummary(mac.probe, NOW), 'Active · runsc 0.1 · checked today 9:11 AM')
    assert.deepEqual(gvisorBadge(mac.settings, mac.probe), { label: 'Active', on: true })
    const detailed = createFakeVmsState('progress', NOW)
    assert.equal(probeSummary(detailed.probe, NOW), 'Active · runsc · idmap ok · chromium ok · checked today 9:11 AM')
    assert.equal(detailed.settings.gvisor, 'force_on')
  })

  it('snapshot budgets: mockup 06 messages, and a valid draft patches', () => {
    const bad = budgetErrors({ perBotMb: '4096', globalMb: '500', freeFloorMb: '1024' })
    assert.equal(bad.perBotMb, "Per-bot budget can't be larger than the global budget.")
    assert.equal(bad.globalMb, 'Must be a whole number from 1024 to 204800.')
    assert.equal(bad.freeFloorMb, 'Must be a whole number from 3072 to 51200.')
    assert.equal(budgetPatch({ perBotMb: '4096', globalMb: '500', freeFloorMb: '1024' }), null)
    assert.deepEqual(budgetPatch({ perBotMb: '2048', globalMb: '15360', freeFloorMb: '5120' }), { perBotMb: 2048, globalMb: 15360, freeFloorMb: 5120 })
    assert.match(BUDGET_HINTS.perBotMb, /256–20480 · default 2048/)
  })

  it('backup rows and the restore subtitle', () => {
    const state = createFakeVmsState('default', NOW)
    const names = new Map(state.agents.map((a) => [a.id, a.name]))
    const rows = state.backups.map((b) => backupRow(b, names, NOW))
    assert.equal(rows[0].when, 'Today, 3:00 AM')
    assert.equal(rows[0].detail, 'Nightly · 3 bots')
    assert.equal(rows[0].size, '842 MB')
    assert.equal(rows[0].statusLabel, 'Complete')
    assert.equal(rows[0].canRestore, true)
    assert.equal(restoreSubtitle(rows[0]), 'Today, 3:00 AM · Nightly · 3 bots · 842 MB')
    assert.equal(rows[2].detail, 'Before Reset · Primary')
    assert.equal(rows[2].size, '210 MB')
    assert.equal(RESTORE_BODY.includes('machine restored'), true)
    const intro = backupsIntro(state.settings, state.host)
    assert.match(intro, /Nightly at 03:00 local · keep 7/)
    assert.match(intro, /Mac\/Linux path: data\/backups\//)
    assert.equal(scheduleLine(state.settings), 'Time 03:00 · Keep last 7')
    const win = backupsIntro(state.settings, createFakeVmsState('windows', NOW).host)
    assert.match(win, /%LOCALAPPDATA%\\AgentControl\\backups\\<date>\\/)
  })

  it('Windows warning and shared downloads', () => {
    const win = windowsWarning(createFakeVmsState('windows', NOW).host)
    assert.equal(win.title, 'Windows — bot files live inside the Podman machine')
    assert.match(win.body, /Nightly backups are on by default/)
    assert.equal(win.rows.length, 3)
    assert.match(win.location, /not each bot's 10 GB/)
    assert.equal(windowsWarning(createFakeVmsState('default', NOW).host), null)
    const ready = sharedDownloads({ state: 'ready', totalBytes: 1, usedBy: [] })
    assert.equal(ready[0].sub, 'Headless Chromium · about 1.3 GB · ready · used by 0 bots')
    assert.equal(ready[0].remove, true)
    assert.equal(ready[1].required, true)
    assert.equal(ready[1].sub, 'Built locally · ready')
    assert.equal(sharedDownloads({ state: 'ready', totalBytes: 1, usedBy: ['primary'] })[0].remove, false)
  })

  it('active runs and the load-error copy', () => {
    assert.equal(runsLookActive([{ status: 'running' }]), true)
    assert.equal(runsLookActive([{ status: 'succeeded' }]), false)
    assert.equal(LOAD_ERROR_TITLE, "Couldn't load VMs settings")
    assert.match(LOAD_ERROR_TEXT, /try again/)
    assert.match(BACKUP_LIST_ERROR, /Couldn't load backups/)
    assert.equal(typeof VMS_PAGE_GAPS.G1, 'string')
  })
})

describe('fake VMs routes (stand-in until BE-P2-18)', () => {
  it('lists backups, refuses a restore without confirm, 404s an unknown id, and 409s while a run is active', () => {
    const state = createFakeVmsState('default', NOW)
    const listed = fakeVmsDispatch(state, 'GET', '/api/vm/backups', null)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.length, 3)
    const missing = fakeVmsDispatch(state, 'POST', '/api/vm/backups/nope/restore', { confirm: true })
    assert.equal(missing.status, 404)
    const noconfirm = fakeVmsDispatch(state, 'POST', '/api/vm/backups/bk-today/restore', {})
    assert.equal(noconfirm.status, 400)
    const busy = createFakeVmsState('runs', NOW)
    const blocked = fakeVmsDispatch(busy, 'POST', '/api/vm/backups/bk-today/restore', { confirm: true })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.reason, 'runs_active')
    const grow = fakeVmsDispatch(busy, 'POST', '/api/vm/machine/grow', { toGb: 90 })
    assert.equal(grow.status, 409)
  })

  it('a manual backup is 202 in_progress, and a second one is 409 backup_in_progress', () => {
    const state = createFakeVmsState('empty', NOW)
    const created = fakeVmsDispatch(state, 'POST', '/api/vm/backups', {})
    assert.equal(created.status, 202)
    assert.equal(created.body.status, 'in_progress')
    assert.equal(created.body.trigger, 'manual')
    const again = fakeVmsDispatch(state, 'POST', '/api/vm/backups', {})
    assert.equal(again.status, 409)
    assert.equal(again.body.reason, 'backup_in_progress')
  })

  it('PATCH settings merges, and a linux grow is 400', () => {
    const state = createFakeVmsState('linux', NOW)
    const patched = fakeVmsDispatch(state, 'PATCH', '/api/vm/settings', { gvisor: 'force_off' })
    assert.equal(patched.body.gvisor, 'force_off')
    assert.equal(patched.body.snapshotBudget.perBotMb, 2048)
    const grow = fakeVmsDispatch(state, 'POST', '/api/vm/machine/grow', { toGb: 90 })
    assert.equal(grow.status, 400)
  })
})

function httpError(status, message, body) {
  const err = new Error(message)
  err.status = status
  if (body !== undefined) err.body = body
  return err
}

describe('VITE_VMS_FAKE (off unless the flag is the string 1)', () => {
  const liveBackups = async () => [{ id: 'live', status: 'complete', trigger: 'nightly' }]

  it('flag off + 404 route -> the real error, not fake backups', async () => {
    assert.equal(vmsFakeEnabled(undefined), false)
    assert.equal(vmsFakeEnabled(''), false)
    const err = httpError(404, 'Route GET:/api/vm/backups not found', { message: 'Route GET:/api/vm/backups not found' })
    await assert.rejects(
      () => vmsRequestWith('/api/vm/backups', undefined, () => { throw err }, undefined),
      (e) => e === err,
    )
  })

  it('flag off + network failure -> the real error', async () => {
    const err = new TypeError('Failed to fetch')
    await assert.rejects(
      () => vmsRequestWith('/api/vm/settings', undefined, () => { throw err }, undefined),
      (e) => e === err,
    )
  })

  it('flag off + empty 5xx -> the real error', async () => {
    const err = httpError(502, 'Bad gateway')
    await assert.rejects(
      () => vmsRequestWith('/api/vm/host', undefined, () => { throw err }, ''),
      (e) => e === err,
    )
  })

  it('flag off + 200 -> the real payload', async () => {
    const got = await vmsRequestWith('/api/vm/backups', undefined, liveBackups, undefined)
    assert.deepEqual(got, [{ id: 'live', status: 'complete', trigger: 'nightly' }])
  })

  it('flag on + a missing route -> fake data; a real 200 still wins', async () => {
    assert.equal(vmsFakeEnabled('1'), true)
    resetFakeVms('default', NOW)
    const missing = httpError(404, 'Route GET:/api/vm/backups not found', { message: 'Route GET:/api/vm/backups not found' })
    const fake = await vmsRequestWith('/api/vm/backups', undefined, () => { throw missing }, '1')
    assert.equal(Array.isArray(fake), true)
    assert.equal(fake.length, 3)
    assert.equal(fake[0].trigger, 'nightly')
    assert.equal(fake[0].id, 'bk-today')
    const real = await vmsRequestWith('/api/vm/backups', undefined, liveBackups, '1')
    assert.deepEqual(real, [{ id: 'live', status: 'complete', trigger: 'nightly' }])
  })
})

describe('M3 decision 4 copy', () => {
  it('a tool build says build; a script run still says run', () => {
    assert.equal(internetNeverText('Primary', true), "Internet is set to Never for Primary, so this build didn't start. Change it in Settings › VM.")
    assert.equal(internetNeverText('Primary', false), "Internet is set to Never for Primary, so this run didn't start. Change it in Settings › VM.")
  })
  it('the 2nd low-disk sentence gains the ending, and a sentence that already has it is left alone', () => {
    const floor = 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 2.5 GB free.'
    const done = `${floor} Free some space, then try again.`
    assert.equal(finishLowDiskSentence(floor), done)
    assert.equal(finishLowDiskSentence(done), done)
    assert.equal(finishLowDiskSentence('Not enough disk space.'), 'Not enough disk space.')
  })
})
