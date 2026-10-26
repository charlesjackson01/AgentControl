import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useMatch, useNavigate } from 'react-router-dom'
import ChatList from './shell/ChatList'
import CommandPalette from './shell/CommandPalette'
import NewBotDialog from './NewBotDialog'
import SettingsDialog from '../pages/Settings'
import ConversationsProvider from '../state/ConversationsProvider'
import ProfileProvider from '../state/ProfileProvider'
import { useProfile } from '../state/profile-context'
import { useConversations } from '../state/conversations-context'
import { ShellContext, type ShellState } from '../state/shell-context'
import { needsOnboarding } from '../lib/profile'
import { commandAction, type CommandContext, type CommandName } from '../lib/commands'
import { chatListUnread, readChatListOpen, shellShortcut, writeChatListOpen } from '../lib/shell'
import { MOBILE_BACK_PATH, MOBILE_QUERY } from '../lib/mobile'
import Onboarding from '../pages/Onboarding'
import '../shell.css'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export default function AppShell() {
  return (
    <ProfileProvider>
      <OnboardingGate />
    </ProfileProvider>
  )
}

/** First-run setup before the app; never blocks when the BE has no profile route. */
function OnboardingGate() {
  const { profile, setProfile } = useProfile()
  if (profile === undefined) return <div className="cf-shell" aria-busy="true" />
  if (profile && needsOnboarding(profile)) return <Onboarding profile={profile} onDone={setProfile} />
  return (
    <ConversationsProvider>
      <Shell />
    </ConversationsProvider>
  )
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(MOBILE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

/**
 * FE-1: chat-only shell. Optional 308 px chat list (fully hidden when off) + the routed chat.
 * FE-8 (<760 px, 05a/05b): no side panel; the list is its own screen at `/` and ‹ goes back to it.
 */
function Shell() {
  const narrow = useNarrow()
  const [desktopOpen, setDesktopOpen] = useState(() => readChatListOpen(storage()))
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newBotOpen, setNewBotOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const { conversations, agents } = useConversations()
  const navigate = useNavigate()
  const chatId = useMatch('/c/:conversationId')?.params.conversationId
  const chatIsGroup = conversations?.find((c) => c.id === chatId)?.kind === 'group'
  const commandCtx = useMemo<CommandContext>(() => ({ conversationId: chatId, isGroup: chatIsGroup }), [chatId, chatIsGroup])

  const listOpen = narrow ? false : desktopOpen
  const toggleList = useCallback(() => {
    if (narrow) navigate(MOBILE_BACK_PATH)
    else
      setDesktopOpen((o) => {
        writeChatListOpen(storage(), !o)
        return !o
      })
  }, [narrow, navigate])
  const closeListIfOverlay = useCallback(() => {}, [])

  const openSwitcher = useCallback(() => setSwitcherOpen(true), [])
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openNewBot = useCallback(() => {
    setSwitcherOpen(false)
    setPaletteOpen(false)
    setNewBotOpen(true)
  }, [])
  const openPalette = useCallback(() => {
    setSwitcherOpen(false)
    setPaletteOpen(true)
  }, [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const runCommand = useCallback(
    (name: CommandName, args = '') => {
      const action = commandAction(name, commandCtx, args)
      if (action.kind === 'unavailable') return action.reason
      setPaletteOpen(false)
      // FE-5 turns `/new <text>` into the in-chat draft card; until then it opens the New bot form.
      if (action.kind === 'new-bot') openNewBot()
      else navigate(action.to)
      return null
    },
    [commandCtx, navigate, openNewBot],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shellShortcut(e)
      if (!action) return
      e.preventDefault()
      if (action === 'toggle-list') toggleList()
      else openPalette()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleList, openPalette])

  const unread = chatListUnread(conversations ?? [], agents)
  const value = useMemo<ShellState>(
    () => ({
      listOpen, toggleList, closeListIfOverlay, narrow, switcherOpen, openSwitcher, closeSwitcher,
      paletteOpen, openPalette, closePalette, runCommand, openSettings, openNewBot, unread,
    }),
    [listOpen, toggleList, closeListIfOverlay, narrow, switcherOpen, openSwitcher, closeSwitcher, paletteOpen, openPalette, closePalette, runCommand, openSettings, openNewBot, unread],
  )

  return (
    <ShellContext.Provider value={value}>
      <div className={`cf-shell${listOpen ? ' cf-shell--list' : ''}${narrow ? ' cf-shell--narrow' : ''}`}>
        {listOpen && <ChatList />}
        <div className="cf-chatcol">
          <Outlet />
          {paletteOpen && <CommandPalette ctx={commandCtx} />}
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <NewBotDialog open={newBotOpen} onClose={() => setNewBotOpen(false)} />
    </ShellContext.Provider>
  )
}
