import { describe, expect, it } from 'vitest'
import { MENTION_SPANS_MAX, MENTION_TEXT_MAX, MENTIONS_MAX, resolveMentions, tag, type MentionCandidate } from './mentions.js'

/**
 * resolveMentions (D-O11): "@" + an agent's name, case-insensitive, longest
 * name first, ending at a word boundary; the "@" starts the text or follows
 * whitespace or an opening bracket/quote; earlier candidates win collisions.
 */

// Preference order as the BE builds it: Primary, then the team, then the library.
const atlas = { id: 'agt_atlas', name: 'Atlas' }
const ana = { id: 'agt_ana', name: 'Ana' }
const copy = { id: 'agt_copy', name: 'Copy' }
const copyEditor = { id: 'agt_copy_editor', name: 'Copy Editor' }
const anaLee = { id: 'agt_ana_lee', name: 'Ana Lee' }
const CANDIDATES: MentionCandidate[] = [atlas, ana, copy, copyEditor, anaLee]

const ids = (text: string, candidates: MentionCandidate[] = CANDIDATES): string[] => resolveMentions(text, candidates).ids

describe('resolveMentions', () => {
  it.each<[string, string, string[]]>([
    ['a name at the start', '@Ana draft the post', [ana.id]],
    ['a name after whitespace', 'Please, @Ana, draft it', [ana.id]],
    ['a name after a newline or tab', 'Done.\n@Atlas\tok?', [atlas.id]],
    ['any case', '@aNA and @ATLAS', [ana.id, atlas.id]],
    ['a name with a space', '@Copy Editor this is ready', [copyEditor.id]],
    ['the longest name first', '@Copy Editor and @Copy', [copyEditor.id, copy.id]],
    ['a shorter name when the longer one is not followed by a boundary', '@Ana Leeway', [ana.id]],
    ['a longer name followed by punctuation', '@Ana Lee: yes', [anaLee.id]],
    ['end of text', 'thanks @Ana', [ana.id]],
    ['punctuation after the name', '@Ana. @Atlas? (@Copy) "@Copy Editor"', [ana.id, atlas.id, copy.id, copyEditor.id]],
    ["a possessive", "@Ana's t1", [ana.id]],
    ['brackets and quotes before the "@"', "[@Ana] {@Atlas} '@Copy' “@Ana Lee” «@Copy Editor»", [
      ana.id,
      atlas.id,
      copy.id,
      anaLee.id,
      copyEditor.id,
    ]],
    ['an angle bracket or a backtick before the "@"', '<@Atlas> `@Ana`', [atlas.id, ana.id]],
    ['order of first appearance, deduped', '@Atlas @Ana @Atlas @ana', [atlas.id, ana.id]],
  ])('tags %s', (_label, text, expected) => {
    expect(ids(text)).toEqual(expected)
  })

  it.each<[string, string]>([
    ['an email address', 'mail ana@b.com or a@Ana'],
    ['a name that continues as a word', '@Anabel @Atlases @Ana_x @Ana-Bot @Ana2'],
    ['an unknown @word', '@Nobody @ @@Ana'],
    ['an "@" after punctuation that is not an opener', 'x,@Ana .@Atlas -@Copy'],
    ['a name without its "@"', 'Ana and Atlas'],
  ])('ignores %s', (_label, text) => {
    expect(ids(text)).toEqual([])
  })

  it('returns spans that cover "@" and the name as written', () => {
    const text = 'Hi @copy editor, ask @Atlas.'
    const { spans } = resolveMentions(text, CANDIDATES)
    expect(spans).toEqual([
      { start: 3, end: 15, agentId: copyEditor.id },
      { start: 21, end: 27, agentId: atlas.id },
    ])
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(['@copy editor', '@Atlas'])
    // Repeated tags keep a span each.
    expect(resolveMentions('@Ana @ana', CANDIDATES).spans.map((s) => s.start)).toEqual([0, 5])
  })

  it('prefers earlier candidates when names collide (Primary, then team, then library)', () => {
    const primary = { id: 'agt_primary', name: 'Sam' }
    const member = { id: 'agt_member', name: 'sam' }
    const library = { id: 'agt_library', name: 'SAM' }
    expect(ids('@Sam', [primary, member, library])).toEqual([primary.id])
    expect(ids('@Sam', [member, library])).toEqual([member.id])
    expect(ids('@sam', [library])).toEqual([library.id])
  })

  it('skips unusable candidates and tolerates none', () => {
    expect(ids('@Ana', [])).toEqual([])
    const odd = [{ id: 'agt_blank', name: '  ' }, { id: 'agt_long', name: 'L'.repeat(201) }, ana] as MentionCandidate[]
    expect(ids(`@${'L'.repeat(201)} @Ana`, odd)).toEqual([ana.id])
    // A stored name with stray spaces is matched by its trimmed name.
    expect(ids('@Bo is here', [{ id: 'agt_bo', name: ' Bo  ' }])).toEqual(['agt_bo'])
    expect(ids('@Ana', [{ id: 1, name: 'Ana' } as unknown as MentionCandidate, null as unknown as MentionCandidate, ana])).toEqual([ana.id])
  })

  it('round-trips the tags the BE writes', () => {
    for (const c of CANDIDATES) expect(ids(`${tag(c.name)} (Role) is next.`)).toEqual([c.id])
  })

  it('is bounded: caps the text scanned, the agents and the spans returned', () => {
    // Only "@" signs in the first MENTION_TEXT_MAX chars count.
    expect(ids(`${' '.repeat(MENTION_TEXT_MAX)}@Ana`)).toEqual([])
    expect(ids(`${' '.repeat(MENTION_TEXT_MAX - 1)}@Ana`)).toEqual([ana.id])

    const many = Array.from({ length: MENTIONS_MAX + 5 }, (_, i) => ({ id: `agt_${i}`, name: `Agent ${i}` }))
    const all = resolveMentions(many.map((c) => tag(c.name)).join(' '), many)
    expect(all.ids).toEqual(many.slice(0, MENTIONS_MAX).map((c) => c.id))
    expect(all.spans.every((s) => all.ids.includes(s.agentId))).toBe(true)

    const repeated = resolveMentions('@Ana '.repeat(MENTION_SPANS_MAX * 3), CANDIDATES)
    expect(repeated.ids).toEqual([ana.id])
    expect(repeated.spans).toHaveLength(MENTION_SPANS_MAX)

    // A long text of "@" signs that tag no one finishes quickly.
    const started = Date.now()
    expect(ids('@x '.repeat(50_000), many)).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
