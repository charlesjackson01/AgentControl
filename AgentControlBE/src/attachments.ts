/**
 * BE-9: chat attachments. An upload lands in the conversation's shared/
 * (a DM: bots/<slug>/shared/; a group: groups/<slug>/shared/, added by the
 * user) and is recorded as shared in that conversation. A message may only
 * attach files uploaded to the same conversation.
 */
import { extname } from 'node:path'
import { botVol, mimeFor, parseClientPath, writeContent } from './files.js'
import { groupVol, writeGroupContent } from './group-files.js'
import { fail } from './http.js'
import { readShares, recordShare } from './share-records.js'
import { storageReady, type StorageBackend, type VolPath } from './storage/index.js'
import type { Agent, Attachment, Conversation, GroupConversation } from './shared/types.js'
import type { WorkspaceStore } from './store.js'

export const MAX_ATTACHMENTS = 10
const MAX_NAME = 255

type Target = { root: VolPath; kind: 'agent'; agent: Agent } | { root: VolPath; kind: 'group'; group: GroupConversation }

function targetOf(store: WorkspaceStore, conversation: Conversation): Target {
  if (conversation.kind === 'group') return { root: groupVol(conversation.slug), kind: 'group', group: conversation }
  const agent = store.agents.find((a) => a.id === conversation.agentId)
  if (!agent) fail(404, `No agent for conversation "${conversation.id}"`)
  return { root: botVol(agent), kind: 'agent', agent }
}

function parseName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') fail(400, '"name" is required, e.g. ?name=report.pdf.')
  const name = raw.trim()
  if (name.length > MAX_NAME) fail(400, `"name" must be at most ${MAX_NAME} characters.`)
  if (/[/\\\0]/.test(name) || name === '.' || name === '..') fail(400, '"name" must be a file name, not a path.')
  parseClientPath(`shared/${name}`, 'name')
  return name
}

/** "report.pdf", then "report (2).pdf", "report (3).pdf"… in shared/. */
function freeSharedName(fs: StorageBackend, root: VolPath, name: string): string {
  const ext = extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  const suffix = ext && ext !== name ? ext : ''
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem} (${n})${suffix}`
    if (fs.stat(root, ['shared', candidate]) === null) return candidate
  }
}

export function uploadAttachment(store: WorkspaceStore, conversation: Conversation, rawName: unknown, body: Buffer): Attachment {
  const target = targetOf(store, conversation)
  const fs = storageReady(store)
  const name = freeSharedName(fs, target.root, parseName(rawName))
  const path = `shared/${name}`
  const entry = target.kind === 'group'
    ? writeGroupContent(store, target.group, path, body, false, 'user')
    : writeContent(store, target.agent, path, body, false)
  recordShare(fs, target.root, path, { sharedAt: new Date().toISOString(), sharedInConversationId: conversation.id })
  return { root: target.kind, path, name, size: entry.size, mime: entry.mime ?? mimeFor(name) }
}

/** The message's attachments, checked against this conversation's uploads and re-read from disk. */
export function resolveAttachments(store: WorkspaceStore, conversation: Conversation, raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail(400, '"attachments" must be an array of attachments from earlier uploads.')
  if (raw.length > MAX_ATTACHMENTS) fail(400, `A message can carry at most ${MAX_ATTACHMENTS} attachments.`)
  if (raw.length === 0) return []
  const target = targetOf(store, conversation)
  const fs = storageReady(store)
  const shares = readShares(fs, target.root)
  const out: Attachment[] = []
  for (const item of raw as unknown[]) {
    const a = (item ?? {}) as Partial<Attachment>
    const path = typeof a.path === 'string' ? a.path : ''
    const label = path || 'that file'
    if (a.root !== target.kind || !path || shares[path]?.sharedInConversationId !== conversation.id) {
      fail(400, `"${label}" wasn't uploaded to this conversation. Upload it with PUT /api/conversations/${conversation.id}/uploads first.`)
    }
    let size = 0
    try {
      const info = fs.stat(target.root, parseClientPath(path))
      if (info?.kind !== 'file') throw new Error('not a file')
      size = info.size
    } catch {
      fail(400, `"${path}" is no longer in the shared files.`)
    }
    if (out.some((o) => o.path === path)) continue
    const name = path.split('/').at(-1)!
    out.push({ root: target.kind, path, name, size, mime: mimeFor(name) })
  }
  return out
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The line a run sees, with paths as the bot's file tools take them. */
export function attachmentPrompt(attachments: readonly Attachment[]): string {
  if (attachments.length === 0) return ''
  const list = attachments.map((a) => `${a.root === 'group' ? 'group:' : ''}${a.path} (${formatSize(a.size)})`).join(', ')
  return `User attached: ${list}. Read them with the file tools.`
}
