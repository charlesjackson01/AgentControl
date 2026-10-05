import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import { MenuIcon, PanelIcon, SearchIcon } from './icons'
import { allNav } from '../lib/nav'
import { useSidebar } from '../hooks/useSidebar'

export default function AppShell() {
  const sidebar = useSidebar()
  const { pathname } = useLocation()
  const current = allNav.find((n) => pathname.startsWith(n.to))

  useEffect(() => {
    if (!sidebar.mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') sidebar.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sidebar])

  return (
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
            <span className="crumbs__current">{current?.label ?? 'Overview'}</span>
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
  )
}
