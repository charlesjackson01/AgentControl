import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { budgetMemoryFields, describePromptBudget, grantedToolNames, skillPromptModeLabel } from '../src/lib/prompt-budget.ts'

const budget = (overrides) => ({
  contextWindow: 8192,
  responseReserve: 4096,
  estimatedTokens: 1234,
  mode: 'full',
  summarizedSkillIds: [],
  toolNames: [],
  ...overrides,
})
describe('prompt budget line', () => {
  it('BE-7 catalog: fits, with the catalog size', () => {
    assert.deepEqual(describePromptBudget(budget({ mode: 'catalog', contextWindow: 32768, estimatedTokens: 4289, catalogTokens: 2625 })), {
      tone: 'ok',
      text:
        'About 4,289 tokens of instructions and skills, within the 32,768-token window (4,096 kept for replies). ' +
        'Skills are listed in a 2,625-token catalog and loaded only when a task needs them.',
    })
    assert.doesNotMatch(describePromptBudget(budget({ mode: 'catalog', catalogTokens: 0 })).text, /catalog/, 'no skills, no catalog note')
  })

  it("older backends' full and summary both read as fitting (no summary wording)", () => {
    const fits = 'About 1,234 tokens of instructions and skills, within the 8,192-token window (4,096 kept for replies).'
    assert.deepEqual(describePromptBudget(budget()), { tone: 'ok', text: fits })
    assert.deepEqual(describePromptBudget(budget({ mode: 'summary', summarizedSkillIds: ['deep-research'] })), { tone: 'ok', text: fits })
  })

  it('warns that runs will be rejected and how to fix it', () => {
    const message = describePromptBudget(budget({ mode: 'too-large', contextWindow: 4096, estimatedTokens: 15_000, catalogTokens: 9000 }))
    assert.equal(message.tone, 'warn')
    assert.equal(
      message.text,
      'Runs will be rejected: about 15,000 tokens of instructions and skills, plus 4,096 kept for replies, ' +
        "do not fit the 4,096-token window. Detach skills, shorten the instructions, or raise the endpoint's context window in Settings.",
    )
  })
})

describe('past-run skill modes', () => {
  it("labels BE-7 'catalog' and the older 'full' / 'summary'", () => {
    assert.equal(skillPromptModeLabel('catalog'), 'Catalog (loaded on demand)')
    assert.equal(skillPromptModeLabel('summary'), 'Summary')
    assert.equal(skillPromptModeLabel('full'), 'Full text')
    assert.equal(skillPromptModeLabel(undefined), 'Full text', 'runs from before modes existed')
  })
})

describe('tools granted by the selected skills', () => {
  const skills = [
    { id: 'a', tools: [{ name: 'csv_summary' }, { name: 'recall' }] },
    { id: 'b', tools: [{ name: 'recall' }, { name: 'remember' }] },
    { id: 'legacy' },
  ]
  it('dedupes in attachment order and skips unknown or tool-less skills', () => {
    assert.deepEqual(grantedToolNames(skills, ['b', 'a', 'missing', 'legacy']), ['recall', 'remember', 'csv_summary'])
    assert.deepEqual(grantedToolNames(skills, []), [])
  })
})

describe('prompt budget: BE-4 memory fields (4c35e03)', () => {
  it('saved bot: agentId only, so the BE uses its memory block, recall and saved memoryLearn', () => {
    assert.deepEqual(budgetMemoryFields({ agentId: 'agt_1', savedLearn: true }), { agentId: 'agt_1' })
    assert.deepEqual(budgetMemoryFields({ agentId: 'agt_1', savedLearn: false, formLearn: false }), { agentId: 'agt_1' })
    assert.deepEqual(budgetMemoryFields({ agentId: 'agt_1', formLearn: true }), { agentId: 'agt_1' }, 'saved default is on')
  })
  it('saved bot: memoryLearn added only when the form changed it from the saved value', () => {
    assert.deepEqual(budgetMemoryFields({ agentId: 'agt_1', savedLearn: true, formLearn: false }), { agentId: 'agt_1', memoryLearn: false })
    assert.deepEqual(budgetMemoryFields({ agentId: 'agt_1', savedLearn: false, formLearn: true }), { agentId: 'agt_1', memoryLearn: true })
  })
  it('new bot: no agentId, memoryLearn as the form has it (default on)', () => {
    assert.deepEqual(budgetMemoryFields({}), { memoryLearn: true })
    assert.deepEqual(budgetMemoryFields({ agentId: null, formLearn: false }), { memoryLearn: false })
    assert.deepEqual(budgetMemoryFields({ agentId: '', formLearn: true }), { memoryLearn: true })
  })
})
