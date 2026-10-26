/** BE-4: remember / recall. The scope comes from the run (DM: the bot's memory; group: the group's). */
import { addMemory, recallMemory } from '../memory.js'
import { MAX_MEMORY_TEXT_CHARS, MEMORY_CATEGORIES } from '../shared/types.js'
import { argError, readEnum, readNumber, readString } from './args.js'
import type { ToolEntry } from './types.js'

const REMEMBER_EXAMPLE = { text: 'Prefers short answers.', category: 'preferences' }
const RECALL_EXAMPLE = { query: 'deploy steps', limit: 5 }
/** Writes per run, so one looping model cannot fill the scope. */
export const MAX_REMEMBER_PER_RUN = 4

export const memoryTools: ToolEntry[] = [
  {
    name: 'remember', category: 'memory', effect: 'write',
    description: 'Save one short lasting fact for future chats. Categories: about-you, preferences, work, other. Example: {"text":"Prefers short answers.","category":"preferences"}',
    parameters: { type: 'object', properties: {
      text: { type: 'string', maxLength: MAX_MEMORY_TEXT_CHARS },
      category: { type: 'string', enum: [...MEMORY_CATEGORIES] },
    }, required: ['text'], additionalProperties: false },
    handler(args, ctx) {
      const scope = ctx.memoryScope
      if (!scope || !ctx.memoryLearn) throw argError('Memory learning is off here.', REMEMBER_EXAMPLE)
      if ((ctx.memoryWrites ??= { count: 0 }).count >= MAX_REMEMBER_PER_RUN) throw argError('Memory write limit reached for this run.', REMEMBER_EXAMPLE)
      const text = readString(args, 'text', { required: true, max: MAX_MEMORY_TEXT_CHARS, example: REMEMBER_EXAMPLE })!.trim()
      if (!text) throw argError('"text" must not be blank.', REMEMBER_EXAMPLE)
      const category = readEnum(args, 'category', MEMORY_CATEGORIES, { fallback: 'other', example: REMEMBER_EXAMPLE })!
      try {
        const item = addMemory(ctx.store, scope, text, category,
          { kind: 'chat', conversationId: ctx.conversationId ?? '', runId: ctx.runId, agentId: ctx.agentId }, ctx.now())
        ctx.memoryWrites.count += 1
        return { saved: { id: item.id, text: item.text, category: item.category } }
      } catch (err) {
        throw argError(err instanceof Error ? err.message : 'Memory could not be saved.', REMEMBER_EXAMPLE)
      }
    },
  },
  {
    name: 'recall', category: 'memory', effect: 'read',
    description: 'Search saved memory for facts matching a query, best match first. Example: {"query":"deploy steps","limit":5}',
    parameters: { type: 'object', properties: {
      query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 },
    }, required: ['query'], additionalProperties: false },
    handler(args, ctx) {
      const scope = ctx.memoryScope
      if (!scope) throw argError('No memory is available here.', RECALL_EXAMPLE)
      const query = readString(args, 'query', { required: true, max: 200, example: RECALL_EXAMPLE })!
      const limit = readNumber(args, 'limit', { min: 1, max: 20, integer: true, example: RECALL_EXAMPLE }) ?? 5
      const items = recallMemory(ctx.store, scope, query, limit)
      return { items: items.map((m) => ({ id: m.id, text: m.text, category: m.category, updatedAt: m.updatedAt })) }
    },
  },
]
