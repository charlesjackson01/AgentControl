import { NavLink } from 'react-router-dom'
import { SparkIcon } from './icons'
import { primaryNav, secondaryNav, type NavItem } from '../lib/nav'
import type { useSidebar } from '../hooks/useSidebar'

type SidebarProps = ReturnType<typeof useSidebar>

function NavRow({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate: () => void }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) => `nav__item${isActive ? ' nav__item--active' : ''}`}
    >
      <span className="nav__icon">
        <Icon size={17} />
      </span>
      <span className="nav__text sidebar__fade">{item.label}</span>
      {item.count !== undefined && <span className="nav__count sidebar__fade">{item.count}</span>}
      {collapsed && <span className="nav__tip" role="tooltip">{item.label}</span>}
    </NavLink>
  )
}

export default function Sidebar({ collapsed, mobileOpen, isMobile, close }: SidebarProps) {
  // On mobile the drawer is always full-width, so labels never fade out.
  const rail = collapsed && !isMobile
  const classes = ['sidebar', rail ? 'sidebar--collapsed' : '', mobileOpen ? 'sidebar--open' : '']

  return (
    <aside className={classes.filter(Boolean).join(' ')}>
      <div className="brand">
        <span className="brand__mark">
          <SparkIcon size={16} />
        </span>
        <span className="brand__text sidebar__fade">
          <span className="brand__name">AgentControl</span>
          <span className="brand__tag">Console</span>
        </span>
      </div>

      <nav className="nav" aria-label="Main">
        <p className="nav__label sidebar__fade">Workspace</p>
        {primaryNav.map((item) => (
          <NavRow key={item.to} item={item} collapsed={rail} onNavigate={close} />
        ))}
        <div className="nav__spacer" />
        {secondaryNav.map((item) => (
          <NavRow key={item.to} item={item} collapsed={rail} onNavigate={close} />
        ))}
      </nav>

      <div className="sidebar__footer">
        <button type="button" className="account">
          <span className="avatar">
            CJ
            <span className="avatar__dot" />
          </span>
          <span className="account__text sidebar__fade">
            <span className="account__name">Casey Jack</span>
            <span className="account__role">Workspace owner</span>
          </span>
        </button>
      </div>
    </aside>
  )
}
