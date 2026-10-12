import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describePromptBudget, grantedToolNames } from '../src/lib/prompt-budget.ts'

const budget = (overrides) => ({
  contextWindow: 8192,
  responseReserve: 4096,
  estimatedTokens: 1234,
  mode: 'full',
  summarizedSkillIds: [],
  toolNames: [],
  ...overrides,
})
const names = new Map([
  ['code-review', 'code-review'],
  ['deep-research', 'Deep Research'],
  ['summarization', 'Summarization'],
])

describe('prompt budget line', () => {
  it('reports a full prompt within the window', () => {
    assert.deepEqual(describePromptBudget(budget()), {
      tone: 'ok',
      text: 'About 1,234 tokens of instructions and skills, within the 8,192-token window (4,096 kept for replies).',
    })
  })

  it('names the summarized skills and how the agent reads them', () => {
    assert.deepEqual(describePromptBudget(budget({ mode: 'summary', estimatedTokens: 2900, summarizedSkillIds: ['deep-research'] }), names), {
      tone: 'info',
      text:
        'About 2,900 tokens of instructions and skills, within the 8,192-token window (4,096 kept for replies). ' +
        'To fit, Deep Research is sent as a short summary; the agent reads its full text with get_skill when needed.',
    })
    const many = describePromptBudget(budget({ mode: 'summary', summarizedSkillIds: ['deep-research', 'gone-skill', 'summarization'] }), names)
    assert.match(many.text, /To fit, Deep Research, gone-skill and Summarization are sent as short summaries; the agent reads their full text with get_skill when needed\.$/)
    const ids = Array.from({ length: 8 }, (_, i) => `s${i}`)
    assert.match(describePromptBudget(budget({ mode: 'summary', summarizedSkillIds: ids })).text, /To fit, s0, s1, s2, s3, s4 and 3 more are sent/)
  })

  it('warns that runs will be rejected and how to fix it', () => {
    const message = describePromptBudget(
      budget({ mode: 'too-large', contextWindow: 4096, estimatedTokens: 15_000, summarizedSkillIds: ['code-review'] }),
      names,
    )
    assert.equal(message.tone, 'warn')
    assert.equal(
      message.text,
      'Runs will be rejected: about 15,000 tokens of instructions and skills, plus 4,096 kept for replies, ' +
        "do not fit the 4,096-token window even with skills sent as summaries. Detach skills, shorten the instructions, or raise the endpoint's context window in Settings.",
    )
    assert.doesNotMatch(describePromptBudget(budget({ mode: 'too-large' })).text, /even with/)
  })
})

describe('tools granted by the selected skills', () => {
  const skills = [
    { id: 'a', tools: [{ name: 'csv_summary' }, { name: 'read_note' }] },
    { id: 'b', tools: [{ name: 'read_note' }, { name: 'save_note' }] },
    { id: 'legacy' },
  ]
  it('dedupes in attachment order and skips unknown or tool-less skills', () => {
    assert.deepEqual(grantedToolNames(skills, ['b', 'a', 'missing', 'legacy']), ['read_note', 'save_note', 'csv_summary'])
    assert.deepEqual(grantedToolNames(skills, []), [])
  })
})
