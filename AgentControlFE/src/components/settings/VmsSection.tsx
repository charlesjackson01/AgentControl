import { useEffect, useMemo, useRef, useState } from 'react'
import Dialog from '../Dialog'
import { Skeleton } from '../States'
import Toggle from './Toggle'
import { ApiError } from '../../lib/api'
import { vmsRequest } from '../../lib/vms-client'
import { createVmApi } from '../../lib/vm-api'
import { useLive } from '../../state/live-context'
import {
  BACKUP_LIST_ERROR, BUDGET_HINTS, BUDGET_INTRO, DOWNLOADS_INTRO, GROW_BUSY_HINT, GROW_HINT, GVISOR_HINT, GVISOR_MODE_OPTIONS, GVISOR_MODE_SUB,
  LOAD_ERROR_TEXT, LOAD_ERROR_TITLE, REMOVE_DOWNLOAD_BODY, RESTORE_BODY,
  backupRow, backupsEmptyText, backupsIntro, budgetDraftFrom, budgetErrors, budgetPatch, diskFraction, diskUsedText,
  growButtonLabel, growConfirmBody, growConfirmLabel, growConfirmTitle, gvisorBadge, linuxNativeText, machineStateLabel, machineSubtitle,
  probeSummary, restoreSubtitle, runsLookActive, scheduleLine, sharedDownloads, undoneSetup, windowsWarning,
  type BudgetDraft,
} from '../../lib/vms-page'
import type { BackupInfo, BrowserAddonInfo, GlobalRuntimeMode, VmHostInfo, VmProbeResult, VmSettingsView } from '../../lib/types'

const vmApi = createVmApi(vmsRequest, async () => '')

type Names = { id: string; name: string }

type Loaded = {
  settings: VmSettingsView
  host: VmHostInfo
  probe: VmProbeResult | null
  browser: BrowserAddonInfo | null
  backups: BackupInfo[]
  backupError: string | null
  agents: Names[]
  runsActive: boolean
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message.trim() && err.message !== 'Something went wrong.') return err.message.trim()
  if (err instanceof Error && err.message.trim() && err.message !== 'Failed to fetch') return err.message.trim()
  return fallback
}

async function loadVms(liveRuns: readonly { status?: string }[]): Promise<Loaded> {
  const [settings, host, probe, browser, backups, agents] = await Promise.all([
    vmApi.getSettings(),
    vmApi.getHost(),
    vmApi.getProbe().catch(() => null),
    vmApi.getBrowser().catch(() => null),
    vmApi.listBackups().then(
      (rows) => ({ rows, error: null as string | null }),
      (err: unknown) => ({ rows: [] as BackupInfo[], error: messageOf(err, BACKUP_LIST_ERROR) }),
    ),
    vmsRequest<Names[]>('/api/agents').catch(() => [] as Names[]),
  ])
  const pages = await Promise.all(
    agents.map((a) => vmApi.listRuns(a.id).then(
      (page) => page.runs,
      () => [] as { status?: string }[],
    )),
  )
  return {
    settings,
    host,
    probe,
    browser,
    backups: backups.rows,
    backupError: backups.error,
    agents,
    runsActive: runsLookActive(liveRuns) || pages.some((rows) => runsLookActive(rows)),
  }
}

export default function VmsSection() {
  const live = useLive()
  const liveRuns = useMemo(() => Object.values(live.state.runs), [live.state.runs])
  const liveRunsRef = useRef(liveRuns)
  useEffect(() => {
    liveRunsRef.current = liveRuns
  }, [liveRuns])
  const [data, setData] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const [budget, setBudget] = useState<BudgetDraft | null>(null)
  const [budgetNote, setBudgetNote] = useState<string | null>(null)
  const [growOpen, setGrowOpen] = useState(false)
  const [growError, setGrowError] = useState<string | null>(null)
  const [growBusy, setGrowBusy] = useState(false)
  const [restoreId, setRestoreId] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupActionError, setBackupActionError] = useState<string | null>(null)
  const [probeBusy, setProbeBusy] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [now] = useState(() => new Date())

  useEffect(() => {
    let active = true
    loadVms(liveRunsRef.current).then(
      (loaded) => {
        if (!active) return
        setData(loaded)
        setBudget(budgetDraftFrom(loaded.settings))
        setLoading(false)
      },
      () => {
        if (!active) return
        setData(null)
        setFailed(true)
        setLoading(false)
      },
    )
    return () => {
      active = false
    }
  }, [tick])

  const runsActive = (data?.runsActive ?? false) || runsLookActive(liveRuns)

  const patchSettings = async (body: Parameters<typeof vmApi.updateSettings>[0]) => {
    const next = await vmApi.updateSettings(body)
    setData((d) => (d ? { ...d, settings: next } : d))
    return next
  }

  const onGvisor = (gvisor: GlobalRuntimeMode) => {
    if (!data || data.settings.gvisor === gvisor) return
    const prev = data.settings
    setData({ ...data, settings: { ...prev, gvisor } })
    void patchSettings({ gvisor }).catch((err: unknown) => {
      setData((d) => (d ? { ...d, settings: prev } : d))
      setProbeError(messageOf(err, "Couldn't save the gVisor mode."))
    })
  }

  const onBackupsEnabled = (enabled: boolean) => {
    if (!data) return
    const prev = data.settings
    setData({ ...data, settings: { ...prev, backups: { ...prev.backups, enabled } } })
    void patchSettings({ backups: { enabled } }).catch((err: unknown) => {
      setData((d) => (d ? { ...d, settings: prev } : d))
      setBackupActionError(messageOf(err, "Couldn't save backups."))
    })
  }

  const onBudget = (key: keyof BudgetDraft, value: string) => {
    const base = budget ?? (data ? budgetDraftFrom(data.settings) : { perBotMb: '', globalMb: '', freeFloorMb: '' })
    const next = { ...base, [key]: value }
    setBudget(next)
    setBudgetNote(null)
    const patch = budgetPatch(next)
    if (!patch || !data) return
    const same = patch.perBotMb === data.settings.snapshotBudget.perBotMb && patch.globalMb === data.settings.snapshotBudget.globalMb && patch.freeFloorMb === data.settings.snapshotBudget.freeFloorMb
    if (same) return
    void vmApi.updateSettings({ snapshotBudget: patch }).then(
      (saved) => setData((d) => (d ? { ...d, settings: saved } : d)),
      (err: unknown) => setBudgetNote(messageOf(err, "Couldn't save snapshot budgets.")),
    )
  }

  const confirmGrow = () => {
    const toGb = data?.host.machine?.growOffer?.toGb
    if (!data || toGb === undefined) return
    setGrowBusy(true)
    setGrowError(null)
    void vmApi.growMachine(toGb).then(
      (host) => {
        setData((d) => (d ? { ...d, host } : d))
        setGrowOpen(false)
        setGrowBusy(false)
      },
      (err: unknown) => {
        setGrowError(messageOf(err, "Couldn't grow the disk."))
        setGrowOpen(false)
        setGrowBusy(false)
      },
    )
  }

  const confirmRestore = () => {
    if (!restoreId) return
    setRestoreBusy(true)
    void vmApi.restoreBackup(restoreId, { confirm: true }).then(
      () => {
        setRestoreId(null)
        setRestoreBusy(false)
        setRestoreError(null)
      },
      (err: unknown) => {
        setRestoreError(messageOf(err, "Couldn't restore that backup."))
        setRestoreId(null)
        setRestoreBusy(false)
      },
    )
  }

  const backUpNow = () => {
    setBackupBusy(true)
    setBackupActionError(null)
    void vmApi.createBackup({}).then(
      (row) => {
        setData((d) => (d ? { ...d, backups: [row, ...d.backups.filter((b) => b.id !== row.id)] } : d))
        setBackupBusy(false)
      },
      (err: unknown) => {
        setBackupActionError(messageOf(err, "Couldn't start a backup."))
        setBackupBusy(false)
      },
    )
  }

  const recheck = () => {
    setProbeBusy(true)
    setProbeError(null)
    void vmApi.recheckProbe().then(
      (probe) => {
        setData((d) => (d ? { ...d, probe } : d))
        setProbeBusy(false)
      },
      (err: unknown) => {
        setProbeError(messageOf(err, "Couldn't re-check."))
        setProbeBusy(false)
      },
    )
  }

  const confirmRemove = () => {
    setRemoveError(null)
    void vmApi.removeBrowser().then(
      (browser) => {
        setData((d) => (d ? { ...d, browser } : d))
        setRemoveOpen(false)
      },
      (err: unknown) => setRemoveError(messageOf(err, "Couldn't remove the download.")),
    )
  }

  if (loading && !data) {
    return (
      <div className="vms" aria-busy="true">
        <Skeleton height={120} />
        <Skeleton height={120} />
      </div>
    )
  }

  if (failed || !data) {
    return (
      <div className="vms-loaderr" role="alert">
        <p className="vms-loaderr__title">{LOAD_ERROR_TITLE}</p>
        <p className="vms-loaderr__text">{LOAD_ERROR_TEXT}</p>
        <button type="button" className="btn btn--primary" onClick={() => { setData(null); setFailed(false); setLoading(true); setTick((n) => n + 1) }}>Try again</button>
      </div>
    )
  }

  const names = new Map(data.agents.map((a) => [a.id, a.name]))
  const rows = data.backups.map((b) => backupRow(b, names, now))
  const draft = budget ?? budgetDraftFrom(data.settings)
  const errors = budgetErrors(draft)
  const warn = windowsWarning(data.host)
  const steps = undoneSetup(data.host)
  const sub = machineSubtitle(data.host)
  const disk = diskUsedText(data.host)
  const offer = data.host.machine?.growOffer
  const growDisabled = runsActive || !offer
  const badge = gvisorBadge(data.settings, data.probe)
  const stateLabel = machineStateLabel(data.host)
  const downloads = sharedDownloads(data.browser)
  const restoring = rows.find((r) => r.id === restoreId) ?? null

  return (
    <div className="vms">
      {steps.length > 0 && (
        <section className="vms-card vms-setup">
          <h3 className="vms-card__title">Setup</h3>
          <ul className="vms-setup__list">
            {steps.map((s) => (
              <li key={s.id}>
                {s.text}
                {s.helpUrl ? <> <a href={s.helpUrl}>Help</a></> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {warn && (
        <section className="vms-warn" role="note">
          <h3 className="vms-warn__title">{warn.title}</h3>
          <p>{warn.body}</p>
          <ul>
            {warn.rows.map((r) => (
              <li key={r.risk}><span>{r.risk}</span> → {r.then}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="vms-card" aria-label="Machine">
        <div className="vms-card__hd">
          <h3 className="vms-card__title">Machine</h3>
          {stateLabel && <span className={`status${data.host.machine?.state === 'running' ? ' status--running' : data.host.machine?.state === 'error' ? ' status--error' : ''}`}>{stateLabel}</span>}
        </div>
        {sub ? <p className="vms-card__sub">{sub}</p> : <p className="vms-card__sub">{linuxNativeText()}</p>}
        {disk && (
          <>
            <div className="vms-disk"><span>Disk</span><span>{disk}</span></div>
            <div className="vms-bar" aria-hidden="true"><span style={{ width: `${diskFraction(data.host) * 100}%` }} /></div>
          </>
        )}
        {offer && (
          <div className="vms-act">
            <button type="button" className="btn btn--primary" disabled={growDisabled} onClick={() => { setGrowError(null); setGrowOpen(true) }}>{growButtonLabel(offer.toGb)}</button>
            <p className="vms-hint">{GROW_HINT}</p>
          </div>
        )}
        {offer && runsActive && <p className="vms-hint vms-hint--block">{GROW_BUSY_HINT}</p>}
        {growError && <p className="vms-alert" role="alert">{growError}</p>}
      </section>

      <section className="vms-card" aria-label="gVisor (global)">
        <div className="vms-card__hd">
          <h3 className="vms-card__title">gVisor (global)</h3>
          <span className={`status${badge.on ? ' status--running' : ''}`}>{badge.label}</span>
        </div>
        <p className="vms-card__sub">{GVISOR_HINT}</p>
        <div className="vms-split">
          <div>
            <p className="vms-split__t">Mode</p>
            <p className="vms-split__s">{GVISOR_MODE_SUB}</p>
          </div>
          <div className="segmented" role="group" aria-label="gVisor mode">
            {GVISOR_MODE_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" className={`segmented__opt${data.settings.gvisor === opt.value ? ' segmented__opt--on' : ''}`} aria-pressed={data.settings.gvisor === opt.value} onClick={() => onGvisor(opt.value)}>{opt.label}</button>
            ))}
          </div>
        </div>
        <div className="vms-split">
          <div>
            <p className="vms-split__t">Last probe</p>
            <p className="vms-split__s">{probeSummary(data.probe, now)}</p>
          </div>
          <button type="button" className="btn" disabled={probeBusy} onClick={recheck}>{probeBusy ? 'Checking…' : 'Re-check now'}</button>
        </div>
        {probeError && <p className="vms-alert" role="alert">{probeError}</p>}
      </section>

      <section className="vms-card" aria-label="Snapshot budgets">
        <h3 className="vms-card__title">Snapshot budgets</h3>
        <p className="vms-card__sub">{BUDGET_INTRO}</p>
        <div className="vms-budgets">
          {([
            ['perBotMb', 'Per bot (MB)'],
            ['globalMb', 'Global (MB)'],
            ['freeFloorMb', 'Free-floor (MB)'],
          ] as const).map(([key, label]) => (
            <label key={key} className="vms-field">
              <span className="vms-field__l">{label}</span>
              <input className={`input${errors[key] ? ' input--invalid' : ''}`} value={draft[key]} inputMode="numeric" aria-invalid={Boolean(errors[key])} onChange={(e) => onBudget(key, e.target.value)} />
              {errors[key] && <span className="vms-field__err" role="alert">{errors[key]}</span>}
              <span className="vms-field__hint">{BUDGET_HINTS[key]}</span>
            </label>
          ))}
        </div>
        {budgetNote && <p className="vms-alert" role="alert">{budgetNote}</p>}
      </section>

      <section className="vms-card" aria-label="Backups">
        <div className="vms-card__hd">
          <h3 className="vms-card__title">Backups</h3>
          <span className="vms-switch">
            <span className="vms-switch__l">{data.settings.backups.enabled ? 'On' : 'Off'}</span>
            <Toggle on={data.settings.backups.enabled} onChange={onBackupsEnabled} label="Nightly backups" />
          </span>
        </div>
        <p className="vms-card__sub">{backupsIntro(data.settings, data.host)}</p>
        <div className="vms-split">
          <div>
            <p className="vms-split__t">Schedule</p>
            <p className="vms-split__s">{scheduleLine(data.settings)}</p>
          </div>
          <button type="button" className="btn btn--primary" disabled={backupBusy || data.backups.some((b) => b.status === 'in_progress')} onClick={backUpNow}>{backupBusy ? 'Starting…' : 'Back up now'}</button>
        </div>
        {data.backupError ? (
          <p className="vms-alert" role="alert">{data.backupError}</p>
        ) : rows.length === 0 ? (
          <p className="vms-empty">{backupsEmptyText(data.settings.backups.time)}</p>
        ) : (
          <ul className="vms-backs">
            {rows.map((r) => (
              <li key={r.id} className="vms-back">
                <div className="vms-back__txt">
                  <p className="vms-back__when">{r.when}</p>
                  <p className="vms-back__sub">{r.detail}{r.error ? ` · ${r.error}` : ''}</p>
                </div>
                <span className="vms-back__size">{r.size}</span>
                <span className={`status${r.status === 'complete' ? ' status--running' : r.status === 'failed' ? ' status--error' : ' status--queued'}`}>{r.statusLabel}</span>
                {r.canRestore ? (
                  <button type="button" className="btn" disabled={runsActive} onClick={() => { setRestoreError(null); setRestoreId(r.id) }}>Restore…</button>
                ) : <span />}
              </li>
            ))}
          </ul>
        )}
        {backupActionError && <p className="vms-alert" role="alert">{backupActionError}</p>}
        {restoreError && <p className="vms-alert" role="alert">{restoreError}</p>}
      </section>

      {warn && (
        <section className="vms-card" aria-label="Backups location">
          <h3 className="vms-card__title">Backups location</h3>
          <p className="vms-card__sub">{warn.location}</p>
        </section>
      )}

      <section className="vms-card" aria-label="Shared downloads">
        <h3 className="vms-card__title">Shared downloads</h3>
        <p className="vms-card__sub">{DOWNLOADS_INTRO}</p>
        <ul className="vms-downs">
          {downloads.map((d) => (
            <li key={d.id} className="vms-down">
              <div>
                <p className="vms-down__n">{d.name}</p>
                <p className="vms-down__s">{d.sub}</p>
              </div>
              {d.remove ? (
                <button type="button" className="btn" onClick={() => { setRemoveError(null); setRemoveOpen(true) }}>Remove download</button>
              ) : d.required ? <span className="pill">Required</span> : <span />}
            </li>
          ))}
        </ul>
      </section>

      {offer && (
        <Dialog open={growOpen} title={growConfirmTitle(offer.toGb)} subtitle={disk ? `Current disk ${disk}.` : undefined} size="sm" panelClassName="vms-confirm" onClose={() => setGrowOpen(false)} footer={
          <>
            <button type="button" className="btn" onClick={() => setGrowOpen(false)} disabled={growBusy}>Cancel</button>
            <button type="button" className="btn btn--primary" onClick={confirmGrow} disabled={growBusy || runsActive}>{growConfirmLabel(offer.toGb)}</button>
          </>
        }>
          <p className="vms-confirm__body">{growConfirmBody(offer.toGb)}</p>
        </Dialog>
      )}

      <Dialog open={restoring !== null} title="Restore backup?" subtitle={restoring ? restoreSubtitle(restoring) : undefined} size="sm" panelClassName="vms-confirm" onClose={() => setRestoreId(null)} footer={
        <>
          <button type="button" className="btn" onClick={() => setRestoreId(null)} disabled={restoreBusy}>Cancel</button>
          <button type="button" className="btn btn--fill-danger" onClick={confirmRestore} disabled={restoreBusy || runsActive}>Restore backup</button>
        </>
      }>
        <p className="vms-confirm__body">{RESTORE_BODY}</p>
      </Dialog>

      <Dialog open={removeOpen} title="Remove download?" size="sm" panelClassName="vms-confirm" onClose={() => setRemoveOpen(false)} footer={
        <>
          <button type="button" className="btn" onClick={() => setRemoveOpen(false)}>Cancel</button>
          <button type="button" className="btn btn--fill-danger" onClick={confirmRemove}>Remove download</button>
        </>
      }>
        <p className="vms-confirm__body">{REMOVE_DOWNLOAD_BODY}</p>
        {removeError && <p className="vms-alert" role="alert">{removeError}</p>}
      </Dialog>
    </div>
  )
}
