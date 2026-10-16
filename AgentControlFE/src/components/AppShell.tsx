import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import { MenuIcon, PanelIcon, SearchIcon } from './icons'
import { allNav, CHATS_LABEL } from '../lib/nav'
import ConversationsProvider from '../state/ConversationsProvider'
import ProfileProvider from '../state/ProfileProvider'
import { useProfile } from '../state/profile-context'
import { needsOnboarding } from '../lib/profile'
import Onboarding from '../pages/Onboarding'
import { useSidebar } from '../hooks/useSidebar'

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
  if (profile === undefined) return <div className="shell" aria-busy="true" />
  if (profile && needsOnboarding(profile)) return <Onboarding profile={profile} onDone={setProfile} />
  return <Shell />
}

function Shell() {
  const sidebar = useSidebar()
  const { pathname } = useLocation()
  const current = allNav.find((n) => pathname.startsWith(n.to))
  const crumb = current?.label ?? (pathname === '/' || pathname.startsWith('/c/') ? CHATS_LABEL : 'Overview')

  useEffect(() => {
    if (!sidebar.mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') sidebar.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebar])

  return (
    <ConversationsProvider>
    <div className="shell">
      <Sidebar {...sidebar} />

      {sidebar.mobileOpen && <div className="scrim" onClick={sidebar.close} />}

      <div className="shell__main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn--ghost btn--icon topbar__toggle"
            onClick={sidebar.toggle}
            aria-label={sidebar.isMobile ? 'Toggle navigation' : sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={sidebar.isMobile ? sidebar.mobileOpen : !sidebar.collapsed}
          >
            {sidebar.isMobile ? <MenuIcon size={18} /> : <PanelIcon size={18} />}
          </button>

          <div className="crumbs">
            <span>AgentControl</span>
            <span className="crumbs__sep">/</span>
            <span className="crumbs__current">{crumb}</span>
          </div>

          <div className="topbar__actions">
            <button type="button" className="btn btn--ghost searchbtn">
              <SearchIcon size={16} />
              <span className="searchbtn__text">Search</span>
              <kbd className="searchbtn__kbd">⌘K</kbd>
            </button>
          </div>
        </header>

        <Outlet />
      </div>
    </div>
    </ConversationsProvider>
  )
}
