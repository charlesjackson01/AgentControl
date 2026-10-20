/* FE-2 slash commands (composer + palette). Pure; tests/commands.test.mjs. */

export type CommandName = 'new' | 'group' | 'files' | 'skills' | 'memory' | 'settings' | 'sandbox'

export type CommandContext = {
  /** The open chat, if any. */
  conversationId?: string
  /** The open chat is a group (BE-5). */
  isGroup?: boolean
}

/** Bot settings tabs FE-3/FE-4 read from `?panel=settings&tab=`. */
export type SettingsTab = 'profile' | 'memory' | 'skills' | 'files' | 'sandbox'

export type CommandDef = {
  name: CommandName
  label: string
  /** One line under the label. */
  hint: string
  /**
   * Why it can't run yet, or null when it can. Only commands whose backing exists
   * run; the rest stay visible and explain which ticket brings them.
   */
  unavailable: (ctx: CommandContext) => string | null
  /** Settings tab this command opens once it's available (`?panel=settings&tab=`). */
  tab?: SettingsTab
}

const later = (reason: string) => () => reason

export const COMMANDS: readonly CommandDef[] = [
  { name: 'new', label: 'New bot', hint: 'Create a bot', unavailable: () => null },
  { name: 'group', label: 'New group', hint: 'Start a group chat', unavailable: later('Group chats arrive with BE-5 / FE-6.') },
  { name: 'files', label: 'Files', hint: "Open this chat's folder", unavailable: later('Bot folders arrive with BE-2 / FE-4.'), tab: 'files' },
  { name: 'skills', label: 'Skills', hint: "This bot's skills", unavailable: later('The Skills tab arrives with FE-3.'), tab: 'skills' },
  { name: 'memory', label: 'Memory', hint: 'What this chat remembers', unavailable: later('Memory arrives with BE-4 / FE-3.'), tab: 'memory' },
  {
    name: 'settings',
    label: 'Settings',
    hint: "This bot's settings",
    unavailable: (ctx) =>
      !ctx.conversationId ? 'Open a chat first.' : ctx.isGroup ? 'Group settings arrive with FE-6.' : null,
  },
  { name: 'sandbox', label: 'Sandbox', hint: 'Where scripts run', unavailable: later('The Sandbox tab arrives with BE-8 / FE-4.'), tab: 'sandbox' },
]

export function findCommand(name: string): CommandDef | undefined {
  const n = name.toLowerCase()
  return COMMANDS.find((c) => c.name === n)
}

/**
 * The partial command being typed, for the composer popover: the draft is `/` plus
 * letters with no space yet. `"/me"` -> `"me"`, `"/"` -> `""`, `"/new x"` -> null.
 */
export function slashPrefix(draft: string): string | null {
  const m = /^\/([a-z]*)$/i.exec(draft)
  return m ? m[1].toLowerCase() : null
}

/** Commands whose name or label starts with / contains the query; name-prefix matches first. */
export function matchCommands(query: string): CommandDef[] {
  const q = query.trim().replace(/^\//, '').toLowerCase()
  if (!q) return [...COMMANDS]
  const starts = COMMANDS.filter((c) => c.name.startsWith(q))
  const rest = COMMANDS.filter((c) => !starts.includes(c) && (c.name.includes(q) || c.label.toLowerCase().includes(q)))
  return [...starts, ...rest]
}

/** `/name args` -> the command and its argument text; null when it isn't a known command (send it as text). */
export function parseSlash(text: string): { command: CommandDef; args: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!m) return null
  const command = findCommand(m[1])
  return command ? { command, args: (m[2] ?? '').trim() } : null
}

export type CommandAction =
  | { kind: 'new-bot'; args: string }
  | { kind: 'navigate'; to: string }
  | { kind: 'unavailable'; reason: string }

/** What running a command does. The caller performs it (open a dialog, navigate, show the reason). */
export function commandAction(name: CommandName, ctx: CommandContext, args = ''): CommandAction {
  const def = findCommand(name)
  const reason = def ? def.unavailable(ctx) : 'Unknown command.'
  if (reason) return { kind: 'unavailable', reason }
  if (name === 'new') return { kind: 'new-bot', args }
  if (def && ctx.conversationId && (name === 'settings' || def.tab))
    return { kind: 'navigate', to: chatPanelPath(ctx.conversationId, 'settings', { tab: def.tab }) }
  return { kind: 'unavailable', reason: 'Not available yet.' }
}

/**
 * Deep link to a chat with a side panel open. Agreed with FE-3/FE-4:
 * `?panel=settings[&tab=profile|memory|skills|files|sandbox]` and `?panel=files&path=…`.
 */
export function chatPanelPath(
  conversationId: string,
  panel: 'settings' | 'files',
  opts: { tab?: SettingsTab; path?: string } = {},
): string {
  const qs = new URLSearchParams({ panel })
  if (panel === 'settings' && opts.tab) qs.set('tab', opts.tab)
  if (panel === 'files' && opts.path) qs.set('path', opts.path)
  return `/c/${encodeURIComponent(conversationId)}?${qs}`
}

/** Deep link that jumps to one message in its chat (`?m=`). */
export function messagePath(conversationId: string, messageId: string): string {
  return `/c/${encodeURIComponent(conversationId)}?${new URLSearchParams({ m: messageId })}`
}
