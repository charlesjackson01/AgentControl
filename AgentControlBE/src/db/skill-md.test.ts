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

  it('rejects names that are not plain identifiers', () => {
    expect(() => parseSkillMarkdown(withFrontmatter('tools: bad;name'))).toThrow(SkillMarkdownError)
  })
})
