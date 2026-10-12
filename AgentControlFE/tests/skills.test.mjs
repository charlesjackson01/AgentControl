import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePreview } from '../src/lib/skill-markdown.ts'
import { parseSkillMarkdown } from '../../AgentControlBE/src/db/skill-md.ts'
import { classifyImportTools, toggleTool } from '../src/lib/skill-tools.ts'

const markdown = (header) => `---\nname: sample\ndescription: a skill\n${header}\n---\n\nFollow these instructions.\n`

describe('SKILL.md import preview matches backend parsing', () => {
  const cases = [
    ['', []],
    ['tools: [save_note, "list_notes", save_note]', ['save_note', 'list_notes']],
    ['tools: save_note list_notes, custom_tool', ['save_note', 'list_notes', 'custom_tool']],
    ['tools:\n  - save_note\n  - list_notes\nmetadata:\n  - hidden_tool', ['save_note', 'list_notes']],
    ['tools: [save_note, list_notes] # trailing ignored_tool', ['save_note', 'list_notes']],
    ['tools: # block comment\n  - save_note # item comment\n# full-line comment\n\n  - list_notes', ['save_note', 'list_notes']],
    ['tools # comment: save_note', []],
    ['tools: ["hash#tool", \'other#tool\', embedded#hash] # ignored', ['hash#tool', 'other#tool', 'embedded#hash']],
    ['metadata:\n  tools: hidden_tool\n__proto__: ignored', []],
  ]
  for (const [header, expectedTools] of cases) {
    it(`handles ${header || 'absent tools'}`, () => {
      const input = markdown(header)
      assert.deepEqual(parsePreview(input), parseSkillMarkdown(input))
      assert.deepEqual(parsePreview(input).tools, expectedTools)
    })
  }
  it('handles CRLF, quoted comments, and double quote escapes identically', () => {
    const input = markdown('description: "A \\"quote\\" # literal" # ignored\ntools: save_note').replaceAll('\n', '\r\n')
    assert.deepEqual(parsePreview(input), parseSkillMarkdown(input))
  })
  it('reports invalid frontmatter without prototype-key interference', () => {
    for (const input of ['body only', '---\n__proto__: poison\ndescription: something\n---\nbody', '---\nname: something\n---\nbody']) {
      assert.throws(() => parseSkillMarkdown(input), { message: parsePreview(input).error })
    }
  })
  it('deduplicates and caps raw tool names like the backend', () => {
    const input = markdown(`tools: ${Array.from({ length: 80 }, (_, i) => `tool_${i}`).join(', ')}`)
    assert.deepEqual(parsePreview(input), parseSkillMarkdown(input))
    assert.equal(parsePreview(input).tools.length, 64)
  })
})

describe('tool selection and import', () => {
  const known = { name: 'save_note', description: 'Save a note.', parameters: { type: 'object' }, category: 'notes', effect: 'write' }
  const legacy = { name: 'custom_legacy', description: 'Original declaration', parameters: { retained: true } }
  it('retains unknown declarations while adding a canonical built-in, without storing registry metadata', () => {
    const selected = toggleTool([legacy], known)
    assert.deepEqual(selected, [legacy, { name: known.name, description: known.description, parameters: known.parameters }])
    assert.equal(selected[0], legacy)
    assert.deepEqual(toggleTool(selected, known), [legacy])
  })
  it('classifies unknown import names, deduplicates, and enforces the API limit', () => {
    const registry = Array.from({ length: 17 }, (_, i) => ({ ...known, name: `tool_${i}` }))
    const result = classifyImportTools(['unknown', 'tool_0', ...registry.map((tool) => tool.name)], registry)
    assert.equal(result.tools.length, 16)
    assert.equal(new Set(result.tools).size, 16)
    assert.deepEqual(result.ignored, ['unknown', 'tool_16'])
  })
})
