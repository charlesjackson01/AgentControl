import { describe, expect, it } from 'vitest'
import { SkillMarkdownError, parseSkillMarkdown } from './skill-md.js'

const withFrontmatter = (extra: string) => `---\nname: s\ndescription: d\n${extra}\n---\nbody`

describe('parseSkillMarkdown tools', () => {
  it('reads an inline comma/space list', () => {
    expect(parseSkillMarkdown(withFrontmatter('tools: calculate, text_stats')).tools).toEqual(['calculate', 'text_stats'])
  })

  it('reads a bracketed list with quotes', () => {
    expect(parseSkillMarkdown(withFrontmatter('tools: [calculate, "json_query"]')).tools).toEqual(['calculate', 'json_query'])
  })

  it('reads a block list and stops at the next key', () => {
    const parsed = parseSkillMarkdown(withFrontmatter('tools:\n  - calculate\n  - text_stats\nlicense: MIT'))
    expect(parsed.tools).toEqual(['calculate', 'text_stats'])
  })

  it('returns [] when absent and ignores other nested blocks', () => {
    expect(parseSkillMarkdown(withFrontmatter('metadata:\n  author: x\n  - not-a-tool')).tools).toEqual([])
  })

  it('dedupes in order', () => {
    expect(parseSkillMarkdown(withFrontmatter('tools: a a b')).tools).toEqual(['a', 'b'])
  })

  it('returns odd tokens raw (the import route keeps only registry names)', () => {
    expect(parseSkillMarkdown(withFrontmatter('tools: Read, Bash(git:*)')).tools).toEqual(['Read', 'Bash(git:*)'])
  })

  it('treats a __proto__ frontmatter key as plain data', () => {
    const parsed = parseSkillMarkdown('---\n__proto__: x\nname: s\ndescription: d\n---\nbody')
    expect(parsed.name).toBe('s')
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  })

  it('still requires name and description', () => {
    expect(() => parseSkillMarkdown('---\ndescription: d\n---\nbody')).toThrow(SkillMarkdownError)
  })

  it('ignores comments at key and value positions without losing underscores', () => {
    const parsed = parseSkillMarkdown(withFrontmatter('tools # comment: [save_note]\ntools: [text_stats, read_note] # ignored: save_note'))
    expect(parsed.tools).toEqual(['text_stats', 'read_note'])
  })

  it('keeps a block active across blank and comment lines, including after its key', () => {
    expect(parseSkillMarkdown(withFrontmatter('tools: # tools below\n  - text_stats # first\n\n# note\n  # second\n  - read_note\nlicense: MIT\n  - not_a_tool')).tools).toEqual(['text_stats', 'read_note'])
  })

  it('preserves hashes inside quoted values and tokens', () => {
    const parsed = parseSkillMarkdown('---\nname: hash#name\ndescription: "Keep # literal" # comment\ntools: ["a#b", read_note] # end\n---\nbody')
    expect(parsed.name).toBe('hash#name')
    expect(parsed.description).toBe('"Keep # literal"')
    expect(parsed.tools).toEqual(['a#b', 'read_note'])
  })
})
