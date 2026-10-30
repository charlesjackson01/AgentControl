import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { permissionFor } from '../../lib/live-store'
import { actionErrorText, permissionCardView, sendErrorText, type CardAction } from '../../lib/permission-card'
import { renderPermissionCard } from '../../lib/permission-card-render'
import { permissionErrorOf } from '../../lib/vm-api'
import type { BrowserAddonInfo, ChatMessage, PermissionDecision, PermissionRequest, VmInfo, VmPatch } from '../../lib/types'
import { useLive } from '../../state/live-context'

type PermissionCardClient = {
  answerPermission: (requestId: string, decision: PermissionDecision) => Promise<PermissionRequest>
  retryBrowser: (agentId?: string) => Promise<BrowserAddonInfo>
  updateVm: (agentId: string, patch: VmPatch) => Promise<VmInfo>
}

type PermissionCardProps = {
  /** A ChatMessage of kind 'permission' (permissionRequestId). */
  message: Pick<ChatMessage, 'id' | 'permissionRequestId'>
  botName: string
  agentId?: string
  /** Group chats: the group's name, when the request has no groupName. */
  groupName?: string
  /** "Settings › VM" for this bot (absent: shown as plain text). */
  settingsHref?: string
  onSettings?: () => void
  client?: PermissionCardClient
}

/**
 * FE-P2-3: an internet or browser permission card in the chat (mockups 01–05, 09, 10). Updates in
 * place from permission.* events and browser.updated; answers with POST /api/permissions/:id.
 * Logic: lib/permission-card.ts; markup: lib/permission-card-render.ts.
 */
export default function PermissionCard({ message, botName, agentId, groupName, settingsHref, onSettings, client = api.vm }: PermissionCardProps) {
  const { state, loadPermission, loadVm, putPermission, putBrowser, putVm } = useLive()
  const requestId = message.permissionRequestId
  const request = permissionFor(state, requestId)
  const [clientNow, setClientNow] = useState(() => Date.now())
  const [sending, setSending] = useState<PermissionDecision | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [answeredElsewhere, setAnsweredElsewhere] = useState(false)
  const [acting, setActing] = useState<CardAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [turnedOff, setTurnedOff] = useState(false)

  // Not in the store (an older card, or before the pending list arrived): fetch it once.
  const missing = Boolean(requestId) && !request
  useEffect(() => {
    if (missing && requestId) void loadPermission(requestId)
  }, [missing, requestId, loadPermission])

  // A browser setup in progress reads the bot's browser state ("after the current run" while waiting_idle);
  // loadVm keeps it fresh through vm.updated and resyncs.
  const setupAgent =
    request?.type === 'browser' && request.status === 'enabled' && !request.setupError && !request.setup?.readyAt ? request.agentId : undefined
  const needsVm = Boolean(setupAgent) && !(setupAgent && state.vms[setupAgent])
  useEffect(() => {
    if (needsVm && setupAgent) void loadVm(setupAgent)
  }, [needsVm, setupAgent, loadVm])

  // Countdown (pending) and the running rebuild step's clock tick each second.
  const ticking = request?.status === 'pending' || Boolean(request?.setup?.rebuild.startedAt && !request.setup.rebuild.endedAt)
  useEffect(() => {
    if (!ticking) return
    const t = window.setInterval(() => setClientNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [ticking])

  // A request we can't load (deleted, or an M1 server) shows nothing.
  if (!request) return null

  const afterBrowser =
    request.type === 'internet' &&
    Object.values(state.permissions).some((p) => p.type === 'browser' && p.runId === request.runId && p.status === 'enabled')
  const view = permissionCardView({
    request, botName, groupName, afterBrowser,
    nowMs: clientNow + state.clockSkewMs,
    sending, sendError, answeredElsewhere,
    browser: state.browser,
    botBrowserState: state.vms[request.agentId]?.browser?.state,
    acting, actionError, turnedOff,
  })

  const decide = async (decision: PermissionDecision) => {
    if (sending) return
    setSending(decision)
    setSendError(null)
    try {
      putPermission(await client.answerPermission(request.id, decision))
    } catch (err) {
      const e = permissionErrorOf(err)
      if (e.kind === 'resolved') {
        setAnsweredElsewhere(true)
        if (e.request) putPermission(e.request)
        else void loadPermission(request.id)
      } else setSendError(sendErrorText(err))
    } finally {
      setSending(null)
    }
  }

  const act = async (action: CardAction) => {
    if (action === 'settings') {
      onSettings?.()
      return
    }
    if (acting) return
    setActing(action)
    setActionError(null)
    const bot = agentId ?? request.agentId
    try {
      if (action === 'retry') putBrowser(await client.retryBrowser(bot))
      else {
        putVm(await client.updateVm(bot, { permissions: { browser: false } }))
        setTurnedOff(true)
      }
    } catch (err) {
      setActionError(actionErrorText(err, action))
    } finally {
      setActing(null)
    }
  }

  return (
    <div className="rc-wrap">
      {renderPermissionCard(view, {
        busy: sending ?? acting,
        onDecide: (d) => void decide(d),
        onAction: (a) => void act(a),
        settingsHref,
        onSettings,
      })}
    </div>
  )
}
