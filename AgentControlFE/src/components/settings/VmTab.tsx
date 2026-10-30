import { useEffect, useMemo, useState } from 'react'
import ConfirmDialog from '../ConfirmDialog'
import Dialog from '../Dialog'
import { ErrorState, Skeleton } from '../States'
import UndoDialog from '../chat/UndoDialog'
import RunOutputDialog from '../chat/RunOutputDialog'
import { api } from '../../lib/api'
import { vmPaths } from '../../lib/vm-api'
import type { Agent, InternetPolicy, RuntimeMode, ScriptRun, VmHostInfo, VmProbeResult, VmToolsInfo } from '../../lib/types'
import {
  BUILD_WAIT_TEXT, RESET_ACTIVE_TEXT, RESET_TEXT, RESET_TITLE, browserConfirm, envRowErrors, envWith, isBuildActive, packageLabel, vmActionError, vmTabModel, whenText,
  vmHistory,
  type RunHistoryPage,
} from '../../lib/vm-tab'
import { renderVmTab, type EnvEditor, type VmBusy, type VmTabUi } from '../../lib/vm-tab-render'
import { useLive } from '../../state/live-context'
import { useConversations } from '../../state/conversations-context'

type Opened = { kind: 'undo' | 'output'; run: ScriptRun } | null

/**
 * FE-P2-5: Settings › VM (mockups c-settings-vm-tab-v2, -lower, -windows). Replaces the Sandbox placeholder.
 * M1: no Back up / Restore (Export only); no Settings › VMs links.
 * FE-P2-10 (M2): live Browser switch + confirm (mockups 11–13), "Building tools" head with a working
 * Stop build, the build's env row and history rows (mockup 14).
 */
export default function VmTab({ agent }: { agent: Agent }) {
  const { state, loadVm, loadRun, putRun, putVm, putBrowser, vmReply } = useLive()
  const { conversations } = useConversations()
  const vm = state.vms[agent.id]
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [host, setHost] = useState<VmHostInfo | null>(null)
  const [probe, setProbe] = useState<VmProbeResult | null>(null)
  const [busy, setBusy] = useState<VmBusy>(null)
  const [errors, setErrors] = useState<VmTabUi['errors']>({})
  const [editor, setEditor] = useState<EnvEditor | null>(null)
  const [probeNote, setProbeNote] = useState<string | null>(null)
  const [first, setFirst] = useState<RunHistoryPage | null>(null)
  const [older, setOlder] = useState<RunHistoryPage | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [tools, setTools] = useState<{ open: boolean; info: VmToolsInfo | null; error: string | null; busy: boolean }>({ open: false, info: null, error: null, busy: false })
  const [opening, setOpening] = useState<string | null>(null)
  const [opened, setOpened] = useState<Opened>(null)
  // The opener, for focus on close (state, not a ref: handlers are built during render).
  const [lastFocus, setLastFocus] = useState<HTMLElement | null>(null)
  const [browserAsk, setBrowserAsk] = useState<{ open: boolean; error: string | null }>({ open: false, error: null })

  useEffect(() => {
    let live = true
    void loadVm(agent.id).then((v) => live && setLoadFailed(!v))
    return () => {
      live = false
    }
  }, [agent.id, attempt, loadVm])

  useEffect(() => {
    let live = true
    api.vm.getHost().then((h) => live && setHost(h), () => undefined)
    api.vm.getProbe().then((p) => live && setProbe(p), () => undefined)
    return () => {
      live = false
    }
  }, [])

  // The shared Chromium download (usedBy, size, progress); `browser.updated` keeps it current. Re-read after an SSE reset.
  useEffect(() => {
    let live = true
    api.vm.getBrowser().then((b) => live && putBrowser(b), () => undefined)
    return () => {
      live = false
    }
  }, [putBrowser, state.resets])

  // History: vm.runs paints first; the first page of GET /script-runs?limit=50 brings the real hasMore.
  useEffect(() => {
    let live = true
    api.vm.listRuns(agent.id).then(
      (page) => live && setFirst(page),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [agent.id])

  const groupNames = useMemo(() => {
    const out: Record<string, string> = {}
    for (const c of conversations ?? []) if (c.kind === 'group') out[c.id] = c.name
    return out
  }, [conversations])

  const history = useMemo(() => (vm ? vmHistory(vm, first, older) : null), [vm, first, older])

  const model = useMemo(
    () => (vm ? vmTabModel({ vm, botName: agent.name, host, probe, groupNames, olderRuns: history?.runs, browserAddon: state.browser }) : null),
    [vm, agent.name, host, probe, groupNames, history, state.browser],
  )

  if (!vm || !model) {
    if (loadFailed) return <ErrorState title={`Couldn't load ${agent.name}'s VM`} error={new Error("Check that AgentControl is running, then try again.")} onRetry={() => { setLoadFailed(false); setAttempt((n) => n + 1) }} />
    return (
      <div className="cf-set__stack" aria-busy="true">
        <section className="cf-card"><Skeleton width="40%" height={14} /><div style={{ height: 10 }} /><Skeleton height={48} /></section>
        <section className="cf-card"><Skeleton width="30%" height={14} /><div style={{ height: 10 }} /><Skeleton height={80} /></section>
      </div>
    )
  }

  const remember = () => {
    setLastFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  }
  const setError = (section: keyof VmTabUi['errors'], text: string | null) => setErrors((e) => ({ ...e, [section]: text ?? undefined }))

  const act = async (kind: Exclude<VmBusy, null>, section: keyof VmTabUi['errors'], fallback: string, fn: () => Promise<void>) => {
    setBusy(kind)
    setError(section, null)
    try {
      await fn()
    } catch (e) {
      setError(section, vmActionError(e, fallback))
      // GAP-V22: a build started under us; the reload shows the "Building tools" head.
      if (isBuildActive(e)) void loadVm(agent.id)
    } finally {
      setBusy(null)
    }
  }

  const onInternet = (v: InternetPolicy) =>
    void act('internet', 'perm', "Couldn't change internet access. Try again.", async () => putVm(await api.vm.updateVm(agent.id, { internetPolicy: v })))
  const onGvisor = (v: RuntimeMode) =>
    void act('gvisor', 'iso', "Couldn't change isolation. Try again.", async () => putVm(await api.vm.updateVm(agent.id, { gvisor: v })))

  const saveEnv = (index: number, row: { name: string; value: string } | null) => {
    if (row) {
      const errs = envRowErrors(vm.env, index, row.name, row.value)
      if (errs.name || errs.value) {
        setEditor((ed) => (ed ? { ...ed, errors: errs } : ed))
        return
      }
    }
    setBusy('env')
    setError('env', null)
    api.vm.updateVm(agent.id, { env: envWith(vm.env, index, row) }).then(
      (v) => {
        putVm(v)
        setEditor(null)
        setBusy(null)
      },
      (e) => {
        const text = vmActionError(e, "Couldn't save the variable. Try again.")
        // 400s (reserved names and the like) go under the name field, like the local check.
        if ((e as { status?: number })?.status === 400) setEditor((ed) => (ed ? { ...ed, errors: { name: text, value: null } } : ed))
        else setError('env', text)
        setBusy(null)
      },
    )
  }

  const openTools = () => {
    remember()
    setTools({ open: true, info: null, error: null, busy: false })
    api.vm.getVmTools(agent.id).then(
      (info) => setTools((t) => ({ ...t, info })),
      (e) => setTools((t) => ({ ...t, error: vmActionError(e, `Couldn't load ${agent.name}'s tools. Try again.`) })),
    )
  }
  /** Rollback answers the run; Rebuild (M2) answers 202 {run} with the live build. */
  const toolsAction = (fn: () => Promise<ScriptRun | { run: ScriptRun }>, fallback: string) => {
    setTools((t) => ({ ...t, busy: true, error: null }))
    fn().then(
      (res) => {
        putRun('run' in res ? res.run : res)
        setTools({ open: false, info: null, error: null, busy: false })
        void loadVm(agent.id)
      },
      (e) => {
        setTools((t) => ({ ...t, busy: false, error: vmActionError(e, fallback) }))
        if (isBuildActive(e)) void loadVm(agent.id)
      },
    )
  }

  const build = vm.activeBuild
  const onStopBuild = () =>
    build &&
    void act('stopbuild', 'head', "Couldn't stop the build. Try again.", async () => {
      putRun(await api.vm.stopRun(build.runId))
      await loadVm(agent.id)
    })

  const setBrowser = (on: boolean) =>
    // vmReply: a setup that fails at once sends vm.updated `error` before this PATCH's `setting_up` reply.
    vmReply(agent.id, () => api.vm.updateVm(agent.id, { permissions: { browser: on } })).then(() => {
      void api.vm.getBrowser().then(putBrowser, () => undefined)
    })
  const onBrowser = (on: boolean) => {
    if (on) {
      remember()
      setBrowserAsk({ open: true, error: null })
      return
    }
    void act('browser', 'perm', "Couldn't turn the browser off. Try again.", () => setBrowser(false))
  }
  const confirmBrowser = () => {
    setBusy('browser')
    setBrowserAsk((b) => ({ ...b, error: null }))
    setBrowser(true).then(
      () => {
        setBusy(null)
        setBrowserAsk({ open: false, error: null })
      },
      (e) => {
        setBusy(null)
        // GAP-V19: low_disk / internet_never keep the dialog open with the server's text.
        setBrowserAsk((b) => ({ ...b, error: vmActionError(e, "Couldn't turn the browser on. Try again.") }))
      },
    )
  }
  const onBrowserRetry = () =>
    void act('retry', 'perm', "Couldn't try again. Try again in a moment.", async () => {
      putBrowser(await api.vm.retryBrowser(agent.id))
      await loadVm(agent.id)
    })
  const onBrowserRemove = () =>
    void act('remove', 'perm', "Couldn't remove the download. Try again.", async () => putBrowser(await api.vm.removeBrowser()))

  const openRun = (kind: 'undo' | 'output', id: string) => {
    remember()
    setOpening(id)
    setError('history', null)
    void loadRun(id).then((run) => {
      setOpening(null)
      if (run) setOpened({ kind, run })
      else setError('history', "Couldn't open that run. Try again.")
    })
  }

  const before = history?.before
  const onMore = () =>
    void act('more', 'history', "Couldn't load older runs. Try again.", async () => {
      const page = await api.vm.listRuns(agent.id, { before })
      setOlder((o) => ({ runs: [...(o?.runs ?? []), ...page.runs], hasMore: page.hasMore }))
    })

  const ui: VmTabUi = {
    busy,
    errors,
    editor,
    probeNote,
    hasMore: history?.hasMore ?? false,
    exportHref: vmPaths.agentExport(agent.id),
    opening,
  }

  const body = renderVmTab(model, ui, {
    onStart: () => void act('start', 'head', `Couldn't start ${agent.name}'s VM. Try again.`, async () => putVm(await api.vm.startVm(agent.id))),
    onStop: () => void act('stop', 'head', `Couldn't stop ${agent.name}'s VM. Try again.`, async () => putVm(await api.vm.stopVm(agent.id))),
    onReset: () => {
      remember()
      setResetError(null)
      setResetOpen(true)
    },
    onInternet,
    onGvisor,
    onRecheck: () =>
      void act('probe', 'iso', "Couldn't re-check. Try again.", async () => {
        const p = await api.vm.recheckProbe()
        setProbe(p)
        setProbeNote(`Checked ${whenText(p.checkedAt ?? undefined) ?? 'just now'}.`)
        await loadVm(agent.id)
      }),
    onDetails: openTools,
    onEnvEdit: (i) => setEditor({ index: i, name: vm.env[i].name, value: vm.env[i].value, errors: null }),
    onEnvAdd: () => setEditor({ index: -1, name: '', value: '', errors: null }),
    onEnvChange: (field, v) => setEditor((ed) => (ed ? { ...ed, [field]: v, errors: ed.errors ? { ...ed.errors, [field]: null } : null } : ed)),
    onEnvSave: () => editor && saveEnv(editor.index, { name: editor.name, value: editor.value }),
    onEnvCancel: () => setEditor(null),
    onEnvRemove: () => editor && saveEnv(editor.index, null),
    onUndo: (id) => openRun('undo', id),
    onOutput: (id) => openRun('output', id),
    onMore,
    onGrow: (toGb) =>
      void act('grow', 'head', "Couldn't grow the disk. Try again.", async () => {
        setHost(await api.vm.growMachine(toGb))
      }),
    onStopBuild,
    onBrowser,
    onBrowserRetry,
    onBrowserRemove,
    onBuildLog: () => build && openRun('output', build.runId),
  })
  const ask = browserConfirm(agent.name, vm.internetPolicy)

  const ti = tools.info
  return (
    <>
      {body}
      <ConfirmDialog
        open={resetOpen}
        title={RESET_TITLE(agent.name)}
        confirmLabel="Reset VM"
        loading={busy === 'reset'}
        onCancel={() => setResetOpen(false)}
        returnFocus={() => lastFocus}
        onConfirm={() => {
          setBusy('reset')
          setResetError(null)
          api.vm.resetVm(agent.id).then(
            (v) => {
              putVm(v)
              setBusy(null)
              setResetOpen(false)
            },
            (e) => {
              setBusy(null)
              if (isBuildActive(e)) void loadVm(agent.id)
              setResetError(isBuildActive(e) ? BUILD_WAIT_TEXT : (e as { status?: number })?.status === 409 ? RESET_ACTIVE_TEXT : vmActionError(e, `Couldn't reset ${agent.name}'s VM. Try again.`))
            },
          )
        }}
      >
        <p>{RESET_TEXT}</p>
        {resetError && <p className="vm-err" role="alert">{resetError}</p>}
      </ConfirmDialog>
      <ConfirmDialog
        open={browserAsk.open}
        title={ask.title}
        confirmLabel={ask.confirm}
        loading={busy === 'browser'}
        onCancel={() => busy !== 'browser' && setBrowserAsk({ open: false, error: null })}
        returnFocus={() => lastFocus}
        onConfirm={confirmBrowser}
      >
        <p>{ask.lead}</p>
        <ul>
          {ask.items.map((t, i) => (
            <li key={t}>
              {t}
              {i === ask.items.length - 1 && <b>{ask.rule}</b>}
              {i === ask.items.length - 1 && '.'}
            </li>
          ))}
        </ul>
        {browserAsk.error && <p className="vm-err" role="alert">{browserAsk.error}</p>}
      </ConfirmDialog>
      <Dialog
        open={tools.open}
        title={`${agent.name}'s installed tools`}
        subtitle="Rebuild runs the install steps again. Roll back returns to the previous build."
        onClose={() => !tools.busy && setTools((t) => ({ ...t, open: false }))}
        returnFocus={() => lastFocus}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setTools((t) => ({ ...t, open: false }))} disabled={tools.busy}>
              Close
            </button>
            {build && <span className="vm-sub vm-inline">{BUILD_WAIT_TEXT}</span>}
            {ti?.canRollback && (
              <button type="button" className="btn" disabled={tools.busy || !!build} onClick={() => toolsAction(() => api.vm.rollbackTools(agent.id), "Couldn't roll back. Try again.")}>
                Roll back
              </button>
            )}
            <button type="button" className="btn btn--primary" disabled={tools.busy || !ti || !!build} onClick={() => toolsAction(() => api.vm.rebuildTools(agent.id), "Couldn't rebuild. Try again.")}>
              {tools.busy ? 'Starting…' : 'Rebuild'}
            </button>
          </>
        }
      >
        {!ti && !tools.error && <Skeleton height={60} />}
        {ti && (
          <dl className="vm-tools">
            <dt>pip</dt>
            <dd>{ti.tools?.pip.length ? ti.tools.pip.map(packageLabel).join(', ') : 'None'}</dd>
            <dt>npm</dt>
            <dd>{ti.tools?.npm.length ? ti.tools.npm.map(packageLabel).join(', ') : 'None'}</dd>
            <dt>/opt</dt>
            <dd>{ti.tools?.optBin.length ? ti.tools.optBin.join(', ') : 'None'}</dd>
            <dt>System</dt>
            <dd>{ti.packages.length ? ti.packages.map((p) => <code key={p}>{p}</code>) : 'None'}</dd>
            <dt>Build</dt>
            <dd>
              Generation {ti.image.generation}
              {ti.image.builtAt ? `, built ${whenText(ti.image.builtAt)}` : ''}
            </dd>
          </dl>
        )}
        {tools.error && <p className="vm-err" role="alert">{tools.error}</p>}
      </Dialog>
      {opened?.kind === 'undo' && (
        <UndoDialog
          open
          run={opened.run}
          botName={agent.name}
          groupNames={groupNames}
          budgetBytes={vm.usage.snapshots.budgetBytes}
          onClose={() => setOpened(null)}
          onUndone={(r) => {
            putRun(r.run)
            putRun(r.undoRun)
          }}
          returnFocus={() => lastFocus}
        />
      )}
      {opened?.kind === 'output' && (
        <RunOutputDialog run={opened.run} name={model.rows.find((r) => r.id === opened.run.id)?.name ?? (opened.run.kind === 'tool_build' ? 'Tool build' : 'Run')} botName={agent.name} onClose={() => setOpened(null)} returnFocus={() => lastFocus} />
      )}
    </>
  )
}
