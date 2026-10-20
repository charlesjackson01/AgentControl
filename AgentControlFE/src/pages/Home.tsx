import { useEffect, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import BootstrapPage from './BootstrapPage'
import ChatHeader from '../components/shell/ChatHeader'
import { Skeleton } from '../components/States'
import { agentDmPath, homeTarget } from '../lib/shell'
import { useConversations } from '../state/conversations-context'
import { useShell } from '../state/shell-context'

function Waiting() {
  return (
    <>
      <ChatHeader />
      <main className="cf-main" aria-busy="true">
        <div className="cf-thread cf-thread--placeholder">
          <Skeleton height={12} width="30%" />
          <Skeleton height={48} width="60%" />
        </div>
      </main>
    </>
  )
}

/** FE-1 `/`: the newest chat, else Primary's DM; first-run setup when there are no bots. */
export default function Home() {
  const { conversations, agents, loaded, error, reload } = useConversations()
  if (!loaded) return <Waiting />
  const target = homeTarget(conversations ?? [], agents)
  if (target.kind === 'chat') return <Navigate to={`/c/${target.id}`} replace />
  if (target.kind === 'setup' && !error) return <BootstrapPage />
  return (
    <>
      <ChatHeader />
      <main className="cf-main">
        <div className="cf-empty">
          <p>{error ? 'Could not load chats.' : 'No chats yet.'}</p>
          {error && (
            <button type="button" className="cf-btn" onClick={reload}>
              Retry
            </button>
          )}
        </div>
      </main>
    </>
  )
}

/** Retired `/agents/:id` -> that bot's DM. Reloads once when the DM isn't known yet (a just-created bot), then falls back to `/`. */
export function AgentRedirect() {
  const { id = '' } = useParams()
  const { conversations, loaded, reload } = useConversations()
  // The list at mount; any later list is the answer to our one reload.
  const [initial] = useState(() => (loaded ? conversations : null))
  const path = agentDmPath(id, conversations ?? [])
  const missing = loaded && !path
  useEffect(() => {
    if (missing) reload()
    // Only once per mount: a later miss falls through to `/` below.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (path) return <Navigate to={path} replace />
  if (missing && initial !== null && conversations !== initial) return <Navigate to="/" replace />
  if (missing && initial === null) return <Navigate to="/" replace />
  return <Waiting />
}

/** `/settings` (old links): open the Profile & endpoints modal over home. */
export function SettingsRedirect() {
  const shell = useShell()
  useEffect(() => {
    shell.openSettings()
  }, [shell])
  return <Navigate to="/" replace />
}
