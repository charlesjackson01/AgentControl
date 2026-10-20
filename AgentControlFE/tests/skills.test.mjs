import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePreview, serializeSkillMarkdown, skillFileName } from '../src/lib/skill-markdown.ts'
import { parseSkillMarkdown } from '../../AgentControlBE/src/db/skill-md.ts'
import { classifyImportTools, toggleTool } from '../src/lib/skill-tools.ts'
import { filterSkills, matchesSkillQuery } from '../src/lib/skill-search.ts'

const markdown = (header) => `---\nname: sample\ndescription: a skill\n${header}\n---\n\nFollow these instructions.\n`

describe('SKILL.md import preview matches backend parsing', () => {
  const cases = [
    ['', []],
    ['tools: [remember, "recall", remember]', ['remember', 'recall']],
    ['tools: remember recall, custom_tool', ['remember', 'recall', 'custom_tool']],
    ['tools:\n  - remember\n  - recall\nmetadata:\n  - hidden_tool', ['remember', 'recall']],
    ['tools: [remember, recall] # trailing ignored_tool', ['remember', 'recall']],
    ['tools: # block comment\n  - remember # item comment\n# full-line comment\n\n  - recall', ['remember', 'recall']],
    ['tools # comment: remember', []],
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
    const input = markdown('description: "A \\"quote\\" # literal" # ignored\ntools: remember').replaceAll('\n', '\r\n')
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
  const known = { name: 'remember', description: 'Save one short lasting fact.', parameters: { type: 'object' }, category: 'memory', effect: 'write' }
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

describe('SKILL.md export round-trips through the import parser', () => {
  const tool = (name) => ({ name, description: `${name} tool`, parameters: {} })
  /** Export, then parse with the BE importer's parser and the FE preview; both must agree. */
  const roundTrip = (skill) => {
    const markdown = serializeSkillMarkdown(skill)
    const parsed = parseSkillMarkdown(markdown)
    assert.deepEqual(parsePreview(markdown), parsed)
    return { markdown, parsed }
  }

  it('keeps name, description, tag, body, and tools', () => {
    const skill = {
      name: 'csv-analysis',
      description: 'Summarize supplied CSV structure and numeric columns.',
      tag: 'Data',
      content: '# CSV Analysis\n\n1. Call `csv_summary`.\n2. Report the columns.',
      tools: [tool('csv_summary'), tool('read_note')],
    }
    const { markdown, parsed } = roundTrip(skill)
    assert.deepEqual(parsed, { name: skill.name, description: skill.description, tag: 'Data', content: skill.content, tools: ['csv_summary', 'read_note'] })
    assert.match(markdown, /^---\nname: csv-analysis\ndescription: .+\ntag: Data\ntools: csv_summary, read_note\n---\n\n# CSV Analysis/)
  })

  it('keeps special characters in the description verbatim', () => {
    const descriptions = [
      `Quotes "double" and 'single', colons: yes: twice, [brackets], {braces}, - dash`,
      'C# & F#, 100% <b>html</b> & back\\slash \\"escaped\\" — ünïcödé 🚀',
      `Don't strip # this: an open single quote makes the hash literal`,
      'A "quoted # hash" and a trailing backslash \\',
      '---',
      '__proto__: constructor',
    ]
    for (const description of descriptions) {
      const { parsed } = roundTrip({ name: 'Special: "chars" & #1', description, tag: '', content: 'Body.', tools: [] })
      assert.equal(parsed.description, description)
      // The hash follows a space outside quotes, so it would start a comment.
      assert.equal(parsed.name, 'Special: "chars" & ＃1')
    }
  })

  it('swaps a comment-starting hash for a fullwidth one instead of truncating', () => {
    const { parsed } = roundTrip({ name: '#tagged', description: '#1 pick for #urgent work # really', tag: '#core', content: 'Body.', tools: [] })
    assert.equal(parsed.name, '＃tagged')
    assert.equal(parsed.description, '＃1 pick for ＃urgent work ＃ really')
  })

  it('folds line breaks, falls back to the name, and stays importable', () => {
    assert.equal(roundTrip({ name: 'multi', description: 'line one\r\n  line two\nline three', tag: '', content: 'Body.' }).parsed.description, 'line one line two line three')
    assert.equal(roundTrip({ name: 'no-desc', description: '   ', tag: '', content: 'Body.' }).parsed.description, 'no-desc')
  })

  it('keeps a body that looks like frontmatter, normalizing CRLF', () => {
    const content = '---\nname: evil\ndescription: injected\ntools: remember\n---\n\n  indented line\r\nlast # line'
    const { parsed } = roundTrip({ name: 'body', description: 'Body test.', tag: '', content, tools: [] })
    assert.equal(parsed.name, 'body')
    assert.deepEqual(parsed.tools, [])
    assert.equal(parsed.content, content.replace(/\r\n/g, '\n'))
  })

  it('writes each valid tool name once, in order', () => {
    const tools = [tool('remember'), tool('recall'), tool('remember'), tool('bad name'), tool('a,b'), tool('get_skill')]
    assert.deepEqual(roundTrip({ name: 'tools', description: 'Tools.', content: 'Body.', tools }).parsed.tools, ['remember', 'recall', 'get_skill'])
  })

  it('names the file after the id, filename-safe', () => {
    assert.equal(skillFileName('code-review'), 'code-review.md')
    assert.equal(skillFileName('skl_9f2a'), 'skl_9f2a.md')
    assert.equal(skillFileName('../../etc/passwd'), 'etc-passwd.md')
    assert.equal(skillFileName('..'), 'skill.md')
  })

  it('serializes a large description in linear time', () => {
    const description = 'word #tag "quote" '.repeat(20_000)
    const started = performance.now()
    const { parsed } = roundTrip({ name: 'big', description, tag: '', content: 'Body.' })
    assert.ok(performance.now() - started < 1000)
    assert.equal(parsed.description.length, description.trim().length)
  })
})

describe('skill library search', () => {
  const skills = [
    { id: 'csv', name: 'CSV Analysis', description: 'Summarize CSV files.', tag: 'Data', tools: [{ name: 'csv_summary' }, { name: 'recall' }] },
    { id: 'notes', name: 'Notes Organizer', description: 'Tidy shared notes.', tag: 'Notes', tools: [{ name: 'remember' }, { name: 'recall' }] },
    { id: 'legacy', name: 'Legacy', description: '', tag: '' },
  ]
  const ids = (list) => list.map((s) => s.id)

  it('matches declared tool names as well as name, description, and tag', () => {
    assert.deepEqual(ids(filterSkills(skills, 'csv_summary')), ['csv'])
    assert.deepEqual(ids(filterSkills(skills, ' RECALL ')), ['csv', 'notes'])
    assert.deepEqual(ids(filterSkills(skills, 'remem')), ['notes'])
    assert.deepEqual(ids(filterSkills(skills, 'tidy')), ['notes'])
    assert.deepEqual(ids(filterSkills(skills, 'data')), ['csv'])
    assert.deepEqual(ids(filterSkills(skills, '')), ['csv', 'notes', 'legacy'])
    assert.deepEqual(filterSkills(skills, 'get_skill'), [])
    assert.equal(matchesSkillQuery(skills[2], 'legacy'), true)
  })

  it('applies tag filters before the query', () => {
    assert.deepEqual(ids(filterSkills(skills, 'recall', ['Notes'])), ['notes'])
    assert.deepEqual(ids(filterSkills(skills, '', ['Data', 'Notes'])), ['csv', 'notes'])
    assert.deepEqual(filterSkills(skills, 'csv_summary', ['Notes']), [])
  })
})
