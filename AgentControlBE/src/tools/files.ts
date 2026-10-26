/**
 * BE-3: file tools. Argument handling, paging and activity live here; every
 * disk access goes through ctx.files (src/file-service.ts), so this module
 * never imports node:fs. See file-service.ts for what a run can see and write.
 */
import { argError, readBoolean, readEnum, readNumber, readString } from './args.js'
import type { FileService, ToolContext, ToolEntry } from './types.js'

export const FILE_TOOL_NAMES = ['list_files', 'read_file', 'search_files', 'write_file', 'make_folder'] as const
export const FILE_PAGE_CHARS = 8_000
export const FILE_RESULT_MAX_CHARS = 8_700
export const MAX_WRITE_BYTES = 1024 * 1024
const MAX_LIST = 200
const MAX_HITS = 50
const MAX_STEPS = 20
const HEADER_ROOM = 700

function filesOf(ctx: ToolContext): FileService {
  if (!ctx.files) throw new Error('Files are not available in this run.')
  return ctx.files
}

const clip = (s: string): string => (s.length > 120 ? `${s.slice(0, 119)}…` : s)
function step(summary: string, failed: string, path?: string): { summary: string; failed: string; path?: string } {
  return { summary: clip(summary), failed: clip(failed), ...(path ? { path: path.slice(0, 300) } : {}) }
}
const shownArg = (args: Record<string, unknown>): string => (typeof args.path === 'string' ? args.path.trim().replace(/\/$/, '') : '')

/** Record a write on the run's activity (deduped by path; 'added' stays 'added'). */
function recordChange(ctx: ToolContext, entry: { path: string; change: 'added' | 'modified'; bytes: number; modifiedAt: string }): void {
  const list = ctx.activity?.filesChanged
  if (!list) return
  const i = list.findIndex((f) => f.path === entry.path)
  if (i < 0) list.push({ ...entry })
  else list[i] = { ...entry, change: list[i]!.change === 'added' ? 'added' : entry.change }
}

export const fileTools: ToolEntry[] = [
  {
    name: 'list_files',
    category: 'files',
    effect: 'read',
    description: 'List files and folders you can see (max 200). Omit path for the top level. Example: {"path":"shared/","recursive":true}',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder, e.g. "shared/", "workspace/", "group:shared/"' },
        recursive: { type: 'boolean' },
      },
    },
    activity: (args) => step(`Listed ${shownArg(args) || 'files'}`, `Couldn't list ${shownArg(args) || 'files'}`, shownArg(args) || undefined),
    handler(args, ctx) {
      const recursive = readBoolean(args, 'recursive', false)
      const out = filesOf(ctx).list(args.path, { recursive, max: MAX_LIST })
      return {
        path: out.path,
        entries: out.entries,
        ...(out.truncated ? { truncated: true, note: `Showing the first ${MAX_LIST}; list one folder at a time.` } : {}),
        ...(out.entries.length === 0 ? { note: 'This folder is empty.' } : {}),
      }
    },
  },
  {
    name: 'read_file',
    category: 'files',
    effect: 'read',
    maxResultChars: FILE_RESULT_MAX_CHARS,
    description: 'Read a text file, 8,000 chars at a time (offset/limit). Binary files return their details only. Example: {"path":"shared/notes.md"}',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: FILE_PAGE_CHARS },
      },
      required: ['path'],
    },
    activity: (args) => step(`Read ${shownArg(args) || 'a file'}`, `Couldn't read ${shownArg(args) || 'a file'}`, shownArg(args) || undefined),
    handler(args, ctx) {
      const example = { path: 'shared/notes.md' }
      readString(args, 'path', { required: true, example })
      const offset = readNumber(args, 'offset', { min: 0, integer: true, example: { ...example, offset: 0 } }) ?? 0
      const limit = readNumber(args, 'limit', { min: 1, max: FILE_PAGE_CHARS, integer: true, example: { ...example, limit: FILE_PAGE_CHARS } }) ?? FILE_PAGE_CHARS
      const file = filesOf(ctx).read(args.path)
      const { text, tooLarge, ...meta } = file
      if (text === null) {
        return { ...meta, binary: !tooLarge, note: tooLarge ? 'Too large to read here (over 5 MiB).' : 'This is a binary file; its contents cannot be shown as text.' }
      }
      const total = text.length
      if (offset > 0 && offset >= total) throw argError(`That is past the end (${total} chars).`, { path: file.path, offset: 0 })
      const room = Math.min(limit, (ctx.resultMaxChars ?? FILE_RESULT_MAX_CHARS) - HEADER_ROOM)
      if (room < 200) throw new Error('Not enough room left in this conversation to read more. Answer with what you have.')
      let end = Math.min(total, offset + room)
      const c = text.charCodeAt(end - 1)
      if (end < total && c >= 0xd800 && c <= 0xdbff) end -= 1
      const range = total === 0 ? 'empty' : `chars ${offset + 1}-${end} of ${total}`
      const next = end < total ? `. Next: read_file ${JSON.stringify({ path: file.path, offset: end })}` : ', the end.'
      return `${file.path} (${file.mime}, ${file.size} bytes): ${range}${next}\n---\n${text.slice(offset, end)}`
    },
  },
  {
    name: 'search_files',
    category: 'files',
    effect: 'read',
    description: 'Find files by name or text (max 50 hits). path narrows it to one folder. Example: {"query":"invoice","path":"shared/"}',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' } },
      required: ['query'],
    },
    activity: (args) => {
      const what = `${shownArg(args) || 'files'} for "${String(args.query ?? '').slice(0, 60)}"`
      return step(`Searched ${what}`, `Couldn't search ${what}`, shownArg(args) || undefined)
    },
    handler(args, ctx) {
      const example = { query: 'invoice', path: 'shared/' }
      const query = readString(args, 'query', { required: true, max: 200, example })!.trim()
      if (!query) throw argError('"query" is required.', example)
      const { hits, truncated } = filesOf(ctx).search(query, args.path, { maxHits: MAX_HITS })
      return {
        query,
        hits,
        ...(truncated ? { truncated: true, note: 'Stopped early; narrow the search with path.' } : {}),
        ...(hits.length ? {} : { note: 'No matches.' }),
      }
    },
  },
  {
    name: 'write_file',
    category: 'files',
    effect: 'write',
    description: 'Write a text file in workspace/ (or group:shared/ in a group), max 1 MiB. mode: create, overwrite or append. Example: {"path":"workspace/summary.md","content":"# Hi","mode":"create"}',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['create', 'overwrite', 'append'] },
      },
      required: ['path', 'content'],
    },
    activity: (args) => {
      const verb = args.mode === 'overwrite' ? 'Wrote' : args.mode === 'append' ? 'Appended to' : 'Created'
      return step(`${verb} ${shownArg(args) || 'a file'}`, `Couldn't write ${shownArg(args) || 'a file'}`, shownArg(args) || undefined)
    },
    handler(args, ctx) {
      const example = { path: 'workspace/summary.md', content: '# Summary', mode: 'create' }
      readString(args, 'path', { required: true, example })
      const content = typeof args.content === 'string' ? args.content : readString(args, 'content', { required: true, example })!
      const mode = readEnum(args, 'mode', ['create', 'overwrite', 'append'] as const, { fallback: 'create', example })!
      const bytes = Buffer.byteLength(content, 'utf8')
      if (bytes > MAX_WRITE_BYTES) throw argError(`"content" is too large (${bytes} bytes, max ${MAX_WRITE_BYTES} per call). Write it in parts with mode "append".`, example)
      const done = filesOf(ctx).write(args.path, content, mode)
      recordChange(ctx, done)
      return { path: done.path, bytes: done.bytes, mode, change: done.change }
    },
  },
  {
    name: 'make_folder',
    category: 'files',
    effect: 'write',
    description: 'Make a folder in workspace/ (or group:shared/ in a group). Example: {"path":"workspace/drafts"}',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    activity: (args) => step(`Made folder ${shownArg(args)}`.trim(), `Couldn't make folder ${shownArg(args)}`.trim(), shownArg(args) || undefined),
    handler(args, ctx) {
      readString(args, 'path', { required: true, example: { path: 'workspace/drafts' } })
      return filesOf(ctx).makeFolder(args.path)
    },
  },
]

/** Keep a step for the reply's activity (at most 20 per run). */
export function recordStep(ctx: ToolContext, tool: string, entry: ToolEntry, args: Record<string, unknown>, ok: boolean): void {
  if (!entry.activity || !ctx.activity || ctx.activity.steps.length >= MAX_STEPS) return
  try {
    const s = entry.activity(args)
    ctx.activity.steps.push({ tool, summary: ok ? s.summary : (s.failed ?? `Couldn't ${s.summary}`), ok, ...(s.path ? { path: s.path } : {}) })
  } catch {
    // a step line is best-effort
  }
}
