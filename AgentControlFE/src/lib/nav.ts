import type { ComponentType } from 'react'
import { AgentsIcon, NotesIcon, ProjectsIcon, SettingsIcon, SkillLibraryIcon } from '../components/icons'

export type NavItem = {
  label: string
  to: string
  icon: ComponentType<{ size?: number }>
  /** Rendered as a pill next to the label. */
  count?: number
}

export const primaryNav: NavItem[] = [
  { label: 'Agents', to: '/agents', icon: AgentsIcon },
  { label: 'Projects', to: '/projects', icon: ProjectsIcon },
  { label: 'Skill Library', to: '/skills', icon: SkillLibraryIcon },
  { label: 'Notes', to: '/notes', icon: NotesIcon },
]

export const secondaryNav: NavItem[] = [
  { label: 'Settings', to: '/settings', icon: SettingsIcon },
]

export const allNav: NavItem[] = [...primaryNav, ...secondaryNav]
