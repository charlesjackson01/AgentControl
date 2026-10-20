import { useCallback, useEffect, useState } from 'react'
import Avatar from '../Avatar'
import ProfileTab from './ProfileTab'
import MemoryTab from './MemoryTab'
import SkillsTab from './SkillsTab'
import PlaceholderTab from './PlaceholderTab'
import FilesTab from './FilesTab'
import { saveAgentChange } from '../../lib/agent-patch'
import { memoryApi, type MemoryLoad } from '../../lib/memory'
import { SETTINGS_TABS } from '../../lib/settings-tabs'
import { botFolder } from '../../lib/agent-put'
import type { SettingsTab } from '../../lib/commands'
import type { Agent, Endpoint } from '../../lib/types'
import { putRaw, request, serverMessage } from '../../lib/api'
import { filesApi, filesTotal } from '../../lib/files'

const memory = memoryApi(request)
const files = filesApi(request, putRaw, serverMessage)

type Props = {
  agent: Agent
  endpoints: Endpoint[]
  tab: SettingsTab
  onTab: (tab: SettingsTab) => void
  onClose: () => void
  /** After any save so the header / chat list refresh. */
  onSaved?: () => void
  onCleared?: () => void
  onDeleted?: () => void
  /** Files tab folder (`?panel=files&path=…`, raw) and navigation (FE-4). */
  filesPath?: string
  onFilesPath?: (path: string) => void
}

/**
 * FE-3 bot settings: a 720 px right slide-over (03a–03e) with Profile, Memory,
 * Skills, Files and Sandbox tabs. The tab lives in the URL (`?panel=settings&tab=`);
 * Files and Sandbox are FE-4 placeholders.
 */
export default function BotSettingsPanel({ agent: fromList, endpoints, tab, onTab, onClose, onSaved, onCleared, onDeleted, filesPath = 'shared', onFilesPath }: Props) {
  // The latest saved copy wins until the list reload catches up, so one tab's save
  // never resends another tab's stale fields.
  const [saved, setSaved] = useState<Agent | null>(null)
  const agent = saved && saved.id === fromList.id ? saved : fromList
  const [mem, setMem] = useState<MemoryLoad | null>(null)
  const [memAttempt, setMemAttempt] = useState(0)
  // GAP-F2: "Files N" = the whole folder's totalFiles from the latest listing (this root fetch,
  // then every listing FilesTab loads); no count when it is missing or invalid.
  const [filesCount, setFilesCount] = useState<{ id: string; n: number | undefined } | null>(null)

  useEffect(() => {
    let live = true
    files.list(fromList.id, '').then(
      (l) => live && setFilesCount({ id: fromList.id, n: filesTotal(l) }),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [fromList.id])
  const onFilesTotal = useCallback((n: number | undefined) => setFilesCount({ id: fromList.id, n }), [fromList.id])

  useEffect(() => {
    let live = true
    void memory.list(fromList.id).then((r) => {
      if (live) setMem(r)
    })
    return () => {
      live = false
    }
  }, [fromList.id, memAttempt])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.dialog-backdrop, [role="alertdialog"]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const didSave = (a: Agent) => {
    setSaved(a)
    onSaved?.()
  }

  const counts: Partial<Record<SettingsTab, number>> = {
    memory: mem?.status === 'ok' ? mem.page.total : undefined,
    skills: agent.skillIds.length,
    files: filesCount?.id === agent.id ? filesCount.n : undefined,
  }
  const folder = botFolder(agent.slug)
  const sub = [agent.role, agent.isPrimary ? 'personal agent' : null, folder ? `private folder ${folder}` : null].filter(Boolean).join(' · ')

  return (
    <>
      <div className="cf-set-scrim" onMouseDown={onClose} aria-hidden="true" />
      <aside className="cf-set" role="dialog" aria-modal="true" aria-label={`${agent.name} settings`}>
        <header className="cf-set__hdr">
          <Avatar name={agent.name} agentId={agent.id} avatar={agent.avatar} color={agent.color} size="md" decorative />
          <div className="cf-set__who">
            <h2 className="cf-set__name">{agent.name}</h2>
            {sub && <p className="cf-set__sub">{folder ? <>{sub.replace(folder, '')}<code>{folder}</code></> : sub}</p>}
          </div>
          <button type="button" className="cf-set__x" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>
        <nav className="cf-set__tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`cf-set-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="cf-set-body"
              className={`cf-set__tab${tab === t.id ? ' cf-set__tab--on' : ''}`}
              // GAP-F14: Sandbox needs BE-8; the tab stays visible but disabled.
              disabled={t.comingSoon}
              title={t.comingSoon ? 'Coming soon' : undefined}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {counts[t.id] !== undefined && <span className="cf-set__count">{counts[t.id]}</span>}
            </button>
          ))}
        </nav>
        <div className="cf-set__body" id="cf-set-body" role="tabpanel" aria-labelledby={`cf-set-tab-${tab}`}>
          {tab === 'profile' && (
            <ProfileTab key={agent.id} agent={agent} endpoints={endpoints} onSaved={didSave} onClose={onClose} onCleared={onCleared} onDeleted={onDeleted} />
          )}
          {tab === 'memory' && (
            <MemoryTab
              key={agent.id}
              agent={agent}
              load={mem}
              api={memory}
              onRetry={() => setMemAttempt((n) => n + 1)}
              onItems={(items) =>
                setMem((m) => (m?.status === 'ok' ? { status: 'ok', page: { ...m.page, items, total: items.length } } : m))
              }
              onAgentSaved={didSave}
              saveChange={(a, change) => saveAgentChange(request, a, change)}
            />
          )}
          {tab === 'skills' && <SkillsTab key={agent.id} agent={agent} onAgentSaved={didSave} />}
          {tab === 'files' && <FilesTab key={agent.id} agent={agent} path={filesPath} onPath={(p) => onFilesPath?.(p)} onTotal={onFilesTotal} />}
          {tab === 'sandbox' && <PlaceholderTab tab={tab} agent={agent} />}
        </div>
      </aside>
    </>
  )
}
