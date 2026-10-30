import { defaultAgentVm } from '../vm-defaults.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from '../store.js'
import { builtinTools, executeToolCall, type ToolContext } from '../tools.js'
import { clipText } from './limits.js'
import { REDACTED, redactSecrets } from './redact.js'

let dir: string
let ctx: ToolContext
const call = (name: string, args: object = {}) => executeToolCall({ id: 'c', name, arguments: JSON.stringify(args) }, ctx)

beforeEach(() => {
  vi.stubEnv('AGENTCONTROL_SECRET', 'helpers-test-secret')
  vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', '')
  dir = mkdtempSync(join(tmpdir(), 'tool-helpers-'))
  const store = createStore(join(dir, 'store.json'))
  store.agents.push({ id: 'a1', name: 'Author', role: '', description: '', instructions: '', modelId: 'm',
    endpointId: 'ep_local_llama', skillIds: [], isPrimary: true, status: 'idle', createdAt: '', lastRunAt: null, runCount: 0,
    slug: 'author', internetPolicy: 'ask', memoryLearn: true, vm: defaultAgentVm() })
  ctx = { store, agentId: 'a1', runId: 'r1', input: 'hello', allowed: new Set(builtinTools.keys()),
    now: () => new Date('2026-10-12T06:00:00Z'), timeZone: 'UTC', writes: { count: 0 } }
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

describe('redaction of configured secrets', () => {
  it('ignores conventional placeholder keys and trivially short values', () => {
    for (const placeholder of ['EMPTY', 'none', 'ollama', 'sk-no-key-required', 'x', 'ab']) {
      ctx.store.endpointKeys.ep_local_llama = placeholder
      const text = 'none of the EMPTY slots use ollama; sk-no-key-required x ab'
      expect(redactSecrets(text, ctx.store), placeholder).toBe(text)
    }
  })

  it('still redacts real keys, including short tokens and JSON-escaped forms', () => {
    ctx.store.endpointKeys.ep_local_llama = 'hunter2-long-secret'
    vi.stubEnv('AGENTCONTROL_AUTH_TOKEN', 'tiny')
    expect(redactSecrets('k=hunter2-long-secret t=tiny', ctx.store)).toBe(`k=${REDACTED} t=${REDACTED}`)
    ctx.store.endpointKeys.ep_local_llama = 'q"uote\\d'
    expect(redactSecrets(JSON.stringify({ v: 'q"uote\\d' }), ctx.store)).toBe(`{"v":"${REDACTED}"}`)
  })

})

describe('clipText', () => {
  it('never splits a surrogate pair', () => {
    const emoji = '😀'.repeat(10) // 20 UTF-16 units
    for (let max = 2; max <= 21; max++) {
      const clipped = clipText(emoji, max)
      expect(clipped.length).toBeLessThanOrEqual(max)
      const body = clipped.endsWith('…') ? clipped.slice(0, -1) : clipped
      const lastUnit = body.charCodeAt(body.length - 1)
      expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff, `max=${max}`).toBe(false)
    }
    expect(clipText('short', 10)).toBe('short')
  })
})
