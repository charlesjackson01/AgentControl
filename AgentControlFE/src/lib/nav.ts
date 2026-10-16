import type { ComponentType } from 'react'
import { AgentsIcon, NotesIcon, ProjectsIcon, SettingsIcon, SkillLibraryIcon } from '../components/icons'

export type NavItem = {
  label: string
  to: string
  icon: ComponentType<{ size?: number }>
  /** Rendered as a pill next to the label. */
  count?: number
}

/** Chat-first: the sidebar body is the conversation list; these sit in its footer. */
export const primaryNav: NavItem[] = [
  { label: 'Agents', to: '/agents', icon: AgentsIcon },
  { label: 'Projects', to: '/projects', icon: ProjectsIcon },
  { label: 'Skill Library', to: '/skills', icon: SkillLibraryIcon },
  { label: 'Notes', to: '/notes', icon: NotesIcon },
]

export const secondaryNav: NavItem[] = [
  { label: 'Settings', to: '/settings', icon: SettingsIcon },
]

/** Breadcrumb label for conversation routes. */
export const CHATS_LABEL = 'Chats'

export const allNav: NavItem[] = [...primaryNav, ...secondaryNav]
