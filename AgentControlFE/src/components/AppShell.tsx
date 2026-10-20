import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet } from 'react-router-dom'
import ChatList from './shell/ChatList'
import NewBotDialog from './NewBotDialog'
import SettingsDialog from '../pages/Settings'
import ConversationsProvider from '../state/ConversationsProvider'
import ProfileProvider from '../state/ProfileProvider'
import { useProfile } from '../state/profile-context'
import { useConversations } from '../state/conversations-context'
import { ShellContext, type ShellState } from '../state/shell-context'
import { needsOnboarding } from '../lib/profile'
import { chatListUnread, readChatListOpen, shellShortcut, writeChatListOpen } from '../lib/shell'
import Onboarding from '../pages/Onboarding'
import '../shell.css'

const NARROW_QUERY = '(max-width: 759px)'

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
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY)
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return narrow
}

/** FE-1: chat-only shell. Optional 308 px chat list (fully hidden when off) + the routed chat. */
function Shell() {
  const narrow = useNarrow()
  const [desktopOpen, setDesktopOpen] = useState(() => readChatListOpen(storage()))
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newBotOpen, setNewBotOpen] = useState(false)
  const { conversations, agents } = useConversations()

  const listOpen = narrow ? drawerOpen : desktopOpen
  const toggleList = useCallback(() => {
    if (narrow) setDrawerOpen((o) => !o)
    else
      setDesktopOpen((o) => {
        writeChatListOpen(storage(), !o)
        return !o
      })
  }, [narrow])
  const closeListIfOverlay = useCallback(() => {
    if (narrow) setDrawerOpen(false)
  }, [narrow])

  const openSwitcher = useCallback(() => setSwitcherOpen(true), [])
  const closeSwitcher = useCallback(() => setSwitcherOpen(false), [])
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const openNewBot = useCallback(() => {
    setSwitcherOpen(false)
    setNewBotOpen(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shellShortcut(e)
      if (!action) {
        if (e.key === 'Escape' && narrow && drawerOpen) setDrawerOpen(false)
        return
      }
      e.preventDefault()
      if (action === 'toggle-list') toggleList()
      else setSwitcherOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleList, narrow, drawerOpen])

  const unread = chatListUnread(conversations ?? [], agents)
  const value = useMemo<ShellState>(
    () => ({ listOpen, toggleList, closeListIfOverlay, narrow, switcherOpen, openSwitcher, closeSwitcher, openSettings, openNewBot, unread }),
    [listOpen, toggleList, closeListIfOverlay, narrow, switcherOpen, openSwitcher, closeSwitcher, openSettings, openNewBot, unread],
  )

  return (
    <ShellContext.Provider value={value}>
      <div className={`cf-shell${listOpen ? ' cf-shell--list' : ''}${narrow ? ' cf-shell--narrow' : ''}`}>
        {listOpen && <ChatList />}
        {listOpen && narrow && <div className="cf-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
        <div className="cf-chatcol">
          <Outlet />
        </div>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <NewBotDialog open={newBotOpen} onClose={() => setNewBotOpen(false)} />
    </ShellContext.Provider>
  )
}
