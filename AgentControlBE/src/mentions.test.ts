/**
 * D-O11 mentions: resolveMentions (pure) and `mentions` on every project
 * message write, including the user's @tags queuing direct tasks.
 */
import { describe, expect, it } from 'vitest'
import { mentionCandidates, resolveMentions } from './mentions.js'

const A = { id: 'agt_ana', name: 'Ana' }
const B = { id: 'agt_ben', name: 'Ben' }
const LEAD = { id: 'agt_atlas', name: 'Atlas' }
const COPY = { id: 'agt_copy', name: 'Copy Editor' }
const ANA2 = { id: 'agt_ana2', name: 'Ana Maria' }

describe('resolveMentions', () => {
  it('finds @Name tags, in order, deduped', () => {
    const r = resolveMentions('@Ana finished t1; @Ben is next. @Ana again', [A, B])
    expect(r.ids).toEqual(['agt_ana', 'agt_ben'])
    expect(r.spans).toHaveLength(3)
  })

  it('prefers the longest matching name', () => {
    const r = resolveMentions('ping @Ana Maria now', [A, ANA2])
    expect(r.ids).toEqual(['agt_ana2'])
    expect(r.spans[0]?.name).toBe('Ana Maria')
  })

  it('earlier candidates win ties (Primary and the team come first)', () => {
    const r = resolveMentions('@Ana helps', mentionCandidates(LEAD, [A], [{ id: 'agt_other', name: 'Ana' }]))
    expect(r.ids).toEqual(['agt_ana'])
  })

  it('matches case-insensitively and keeps the client spelling', () => {
    const r = resolveMentions('hey @aNa!', [A])
    expect(r.ids).toEqual(['agt_ana'])
    expect(r.spans[0]?.name).toBe('aNa')
  })

  it('ends a name at a word boundary: @Android is not @Ana', () => {
    expect(resolveMentions('ask @Android', [A]).ids).toEqual([])
    expect(resolveMentions('ask @Ana-who', [A]).ids).toEqual(['agt_ana'])
  })

  it('leaves unknown @words and bare @ as plain text', () => {
    expect(resolveMentions('mail @someone @ and @Ana', [A]).ids).toEqual(['agt_ana'])
  })

  it('needs a word character right after the @', () => {
    expect(resolveMentions('@.Ana @ Ana', [A]).ids).toEqual([])
  })

  it('handles names with spaces across word boundaries', () => {
    const r = resolveMentions('assign @Copy Editor the draft', [COPY])
    expect(r.ids).toEqual(['agt_copy'])
    expect(r.spans[0]?.name).toBe('Copy Editor')
  })

  it('mentionCandidates orders Primary and the team first, deduped', () => {
    const c = mentionCandidates(LEAD, [A, LEAD], [B, A])
    expect(c.map((x) => x.id)).toEqual(['agt_atlas', 'agt_ana', 'agt_ben'])
  })

  it('no candidates: no mentions', () => {
    expect(resolveMentions('@Ana', []).ids).toEqual([])
  })
})
