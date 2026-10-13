import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MENTIONS_MAX,
  MENTION_QUERY_MAX,
  MENTION_TEXT_MAX,
  MENTION_TONES,
  activeMentionQuery,
  directTargets,
  exactCandidate,
  filterCandidates,
  insertMention,
  mentionDismissed,
  mentionOrder,
  mentionSpans,
  mentionStartsAt,
  mentionTone,
  pickedMentionIds,
  pickerCandidates,
  sendLabel,
  uniqueIds,
} from '../src/lib/mentions.ts'

// Contract (src/lib/types.ts, D-O11): ProjectMessage.mentions holds the agent
// ids a message tags as @Name, in order of first appearance, deduped; the BE
// fills it on every write. POST /api/projects/:id/messages takes `mentions`
// (ids the user picked); tagging team members and not Primary queues one task
// per member instead of asking Primary for a plan. Both sides share the rules
// tested here.

const atlas = { id: 'lead', name: 'Atlas', role: 'Team Lead' }
const ana = { id: 'ana', name: 'Ana', role: 'Writer' }
const copy = { id: 'copy', name: 'Copy Editor', role: 'Editor' }
const copyLib = { id: 'copy-lib', name: 'Copy', role: 'Copywriter' }
const ben = { id: 'ben', name: 'Ben', role: 'Engineer' }
const agents = [atlas, ana, copy, copyLib, ben]

/** The tagged substrings with their ids, for readable assertions. */
const tags = (text, list = agents, ids) => mentionSpans(text, list, ids).map((s) => [text.slice(s.start, s.end), s.id])

describe('mentionSpans: the shared @mention rules', () => {
  it('finds @Name tags in order, ignoring case', () => {
    assert.deepEqual(tags('@Ana drafts, then @atlas reviews. @BEN!'), [['@Ana', 'ana'], ['@atlas', 'lead'], ['@BEN', 'ben']])
    assert.deepEqual(mentionSpans('hi @Ana', agents), [{ start: 3, end: 7, id: 'ana' }])
    assert.deepEqual(tags(''), [])
    assert.deepEqual(tags('no tags here'), [])
  })

  it('matches the longest name first, so names may contain spaces', () => {
    assert.deepEqual(tags('@Copy Editor please edit'), [['@Copy Editor', 'copy']])
    // "Copy Editorial" is not "Copy Editor" + boundary: falls back to the shorter "Copy".
    assert.deepEqual(tags('@Copy Editorial'), [['@Copy', 'copy-lib']])
    assert.deepEqual(tags('@copy editor, @Copy and @COPY EDITOR'), [
      ['@copy editor', 'copy'],
      ['@Copy', 'copy-lib'],
      ['@COPY EDITOR', 'copy'],
    ])
  })

  it('ends a name at a word boundary: end of text, whitespace or punctuation, never a letter, digit, _ or -', () => {
    for (const text of ['@Ana', '@Ana.', '@Ana,', "@Ana's draft", '@Ana)', '@Ana?!', '@Ana\nnext', '@Ana:']) {
      assert.deepEqual(tags(text), [['@Ana', 'ana']], text)
    }
    for (const text of ['@Anastasia', '@Ana2', '@Ana_b', '@Ana-Maria', '@Anaé', '@Ana𝐀']) assert.deepEqual(tags(text), [], text)
    // A symbol outside the BMP is punctuation, not a letter.
    assert.deepEqual(tags('@Ana🙂'), [['@Ana', 'ana']])
  })

  it('needs the @ at the start, after whitespace or after an opening bracket or quote: emails are not tags', () => {
    assert.deepEqual(tags('mail a@ana.com or ana@Ana'), [])
    assert.deepEqual(tags('x@Ana'), [])
    assert.deepEqual(tags('(@Ana) [@Ben] {@Atlas} "@Ana" \'@Ben\' “@Atlas” ‘@Ana’ «@Ben»').map(([, id]) => id), [
      'ana', 'ben', 'lead', 'ana', 'ben', 'lead', 'ana', 'ben',
    ])
    // Only those openers: not after other punctuation.
    for (const text of ['<@Ana>', '`@Ana`', ',@Ana', '.@Ana', '/@Ana', '#@Ana']) assert.deepEqual(tags(text), [], text)
    assert.deepEqual(tags('\t@Ana'), [['@Ana', 'ana']])
    // Back to back without a space: only the first is a tag.
    assert.deepEqual(tags('@Ana@Ben @Ana,@Ben'), [['@Ana', 'ana'], ['@Ana', 'ana']])
    assert.equal(mentionStartsAt('a@b', 1), false)
    assert.equal(mentionStartsAt('@b', 0), true)
    assert.equal(mentionStartsAt('ab', 0), false)
  })

  it('leaves @words that name no agent as plain text', () => {
    assert.deepEqual(tags('@nobody and @ Ana and @'), [])
    assert.deepEqual(tags('@nobody, @Ana'), [['@Ana', 'ana']])
  })

  it('prefers the earlier agent in the list when two share a name (Primary, team, library)', () => {
    const twin = { id: 'ana-lib', name: 'ana' }
    assert.deepEqual(tags('@Ana', [ana, twin]), [['@Ana', 'ana']])
    assert.deepEqual(tags('@Ana', [twin, ana]), [['@Ana', 'ana-lib']])
    // The longest name still wins over preference.
    assert.deepEqual(tags('@Copy Editor', [copyLib, copy]), [['@Copy Editor', 'copy']])
  })

  it('matches only the given ids (a stored message’s mentions)', () => {
    assert.deepEqual(tags('@Ana and @Ben', agents, ['ben']), [['@Ben', 'ben']])
    assert.deepEqual(tags('@Copy Editor', agents, ['copy-lib']), [['@Copy', 'copy-lib']])
    assert.deepEqual(tags('@Ana', agents, []), [])
    assert.deepEqual(tags('@Ana', agents, ['gone']), [])
  })

  it('ignores blank names and names over 200 characters', () => {
    const long = { id: 'long', name: 'L'.repeat(201) }
    assert.deepEqual(tags(`@ hi @${long.name} @Ana`, [{ id: 'blank', name: '  ' }, long, ana]), [['@Ana', 'ana']])
  })

  it('is bounded like the BE: at most MENTIONS_MAX agents, and only @ signs in the first MENTION_TEXT_MAX characters', () => {
    const many = Array.from({ length: MENTIONS_MAX + 2 }, (_, i) => ({ id: `a${i}`, name: `Agent${i}` }))
    const text = many.map((a) => `@${a.name}`).join(' ')
    assert.equal(uniqueIds(mentionSpans(text, many)).length, MENTIONS_MAX)
    // Agents already tagged are still found after the cap.
    assert.deepEqual(uniqueIds(mentionSpans(`${text} @Agent0`, many)).length, MENTIONS_MAX)
    assert.equal(mentionSpans(`${text} @Agent0`, many).at(-1).id, 'a0')
    const late = `${'x '.repeat(MENTION_TEXT_MAX / 2)}@Ana`
    assert.deepEqual(mentionSpans(late, agents), [])
  })

  it('dedupes ids in order of first appearance', () => {
    assert.deepEqual(uniqueIds(mentionSpans('@Ben @Ana @ben @Atlas @ANA', agents)), ['ben', 'ana', 'lead'])
    assert.deepEqual(uniqueIds([]), [])
  })
})

describe('preference order and picker candidates', () => {
  const library = [
    { id: 'z', name: 'Zed' },
    { id: 'ana', name: 'Ana' },
    { id: 'lead', name: 'Atlas' },
    { id: 'ben', name: 'Ben' },
  ]

  it('orders Primary, then the team in team order, then the rest of the library', () => {
    assert.deepEqual(mentionOrder(library, 'lead', ['ben', 'ana', 'gone', 'ben']).map((a) => a.id), ['lead', 'ben', 'ana', 'z'])
    assert.deepEqual(mentionOrder(library, undefined, []).map((a) => a.id), ['z', 'ana', 'lead', 'ben'])
    // Primary listed in the team as well appears once.
    assert.deepEqual(mentionOrder(library, 'lead', ['lead', 'z']).map((a) => a.id), ['lead', 'z', 'ana', 'ben'])
  })

  it('offers Primary and team members still in the library', () => {
    assert.deepEqual(pickerCandidates(library, 'lead', ['ben', 'gone']).map((a) => a.id), ['lead', 'ben'])
    assert.deepEqual(pickerCandidates(library, undefined, ['ana']).map((a) => a.id), ['ana'])
    assert.deepEqual(pickerCandidates([], 'lead', ['ana']), [])
  })
})

describe('composer: the @query at the caret', () => {
  it('finds the @… being typed at the caret', () => {
    assert.deepEqual(activeMentionQuery('@', 1), { start: 0, query: '' })
    assert.deepEqual(activeMentionQuery('hi @an', 6), { start: 3, query: 'an' })
    assert.deepEqual(activeMentionQuery('hi @an there', 6), { start: 3, query: 'an' })
    // In the middle of the word: the query is what precedes the caret.
    assert.deepEqual(activeMentionQuery('hi @anna', 6), { start: 3, query: 'an' })
    // Names may contain spaces, so the query may too.
    assert.deepEqual(activeMentionQuery('@Copy Ed', 8), { start: 0, query: 'Copy Ed' })
    // The latest @ before the caret counts.
    assert.deepEqual(activeMentionQuery('@Ana and @B', 11), { start: 9, query: 'B' })
    assert.deepEqual(activeMentionQuery('("@Be', 5), { start: 2, query: 'Be' })
  })

  it('is null outside a tag: no @, an email, "@ " with a space, another line, too far back', () => {
    assert.equal(activeMentionQuery('hello', 5), null)
    assert.equal(activeMentionQuery('', 0), null)
    assert.equal(activeMentionQuery('a@b', 3), null)
    assert.equal(activeMentionQuery('at @ noon', 9), null)
    assert.equal(activeMentionQuery('@Ana\nnext', 9), null)
    assert.equal(activeMentionQuery('@an', 0), null)
    const long = `@${'x'.repeat(MENTION_QUERY_MAX)}`
    assert.deepEqual(activeMentionQuery(long, long.length), { start: 0, query: 'x'.repeat(MENTION_QUERY_MAX) })
    assert.equal(activeMentionQuery(`${long}x`, long.length + 1), null)
  })

  it('stays shut after Esc or a pick only while typing on from that @', () => {
    const closed = { start: 3, query: 'an' }
    assert.equal(mentionDismissed({ start: 3, query: 'an' }, closed), true)
    assert.equal(mentionDismissed({ start: 3, query: 'Ana' }, closed), true)
    // Deleting back past it, another @, or no @ at all: open again.
    assert.equal(mentionDismissed({ start: 3, query: 'a' }, closed), false)
    assert.equal(mentionDismissed({ start: 0, query: 'an' }, closed), false)
    assert.equal(mentionDismissed(null, closed), false)
    assert.equal(mentionDismissed({ start: 3, query: 'an' }, null), false)
    // After picking "@Ana ", "Ana Smith" does not reopen it; a new draft's "@" at the same place does.
    const picked = { start: 0, query: 'Ana ' }
    assert.equal(mentionDismissed({ start: 0, query: 'Ana please' }, picked), true)
    assert.equal(mentionDismissed({ start: 0, query: '' }, picked), false)
  })

  it('clamps the caret to the text', () => {
    assert.deepEqual(activeMentionQuery('@an', 99), { start: 0, query: 'an' })
    assert.equal(activeMentionQuery('@an', -4), null)
  })
})

describe('composer: filtering, inserting and the picked ids', () => {
  const candidates = [atlas, ana, copy, { id: 'dana', name: 'Dana', role: 'Analyst' }]

  it('filters by prefix, then substring, ignoring case, keeping Primary first in each group', () => {
    assert.deepEqual(filterCandidates('', candidates), candidates)
    assert.deepEqual(filterCandidates('  ', candidates), candidates)
    assert.deepEqual(filterCandidates('a', candidates).map((c) => c.id), ['lead', 'ana', 'dana'])
    assert.deepEqual(filterCandidates('AN', candidates).map((c) => c.id), ['ana', 'dana'])
    assert.deepEqual(filterCandidates('edit', candidates).map((c) => c.id), ['copy'])
    assert.deepEqual(filterCandidates('copy e', candidates).map((c) => c.id), ['copy'])
    // A space after a whole name narrows to longer names (here none).
    assert.deepEqual(filterCandidates('ana ', candidates), [])
    assert.deepEqual(filterCandidates('zz', candidates), [])
  })

  it('spots a whole name typed out (it counts as picked)', () => {
    assert.equal(exactCandidate('ana', candidates), ana)
    assert.equal(exactCandidate(' Copy Editor ', candidates), copy)
    assert.equal(exactCandidate('an', candidates), null)
    assert.equal(exactCandidate('', candidates), null)
  })

  it('inserts "@Name " in place of the query and moves the caret after it', () => {
    assert.deepEqual(insertMention('hi @an', 3, 6, 'Ana'), { text: 'hi @Ana ', caret: 8 })
    assert.deepEqual(insertMention('@', 0, 1, 'Atlas'), { text: '@Atlas ', caret: 7 })
    // The rest of the word under the caret is replaced too, and an existing space is reused.
    assert.deepEqual(insertMention('@Co please', 0, 2, 'Copy Editor'), { text: '@Copy Editor please', caret: 13 })
    assert.deepEqual(insertMention('@Copy Ed', 0, 8, 'Copy Editor'), { text: '@Copy Editor ', caret: 13 })
    // A line break after the word stays, after the new space.
    assert.deepEqual(insertMention('@a\nnext', 0, 2, 'Ana'), { text: '@Ana \nnext', caret: 5 })
    // Out-of-range positions are clamped.
    assert.deepEqual(insertMention('@a', 0, 99, 'Ana'), { text: '@Ana ', caret: 5 })
  })

  it('keeps only picked agents whose @Name is still in the text, in order of appearance', () => {
    const picked = [ana, copy, atlas]
    assert.deepEqual(pickedMentionIds('@Copy Editor then @Ana and @ana', picked), ['copy', 'ana'])
    assert.deepEqual(pickedMentionIds('@Ana was removed: Ana, a@Atlas', picked), ['ana'])
    assert.deepEqual(pickedMentionIds('nobody', picked), [])
    // An agent typed but never picked is not sent.
    assert.deepEqual(pickedMentionIds('@Ben', picked), [])
  })
})

describe('who gets the message', () => {
  it('goes to tagged team members only when Primary is not tagged', () => {
    assert.deepEqual(directTargets(['ana', 'ben'], 'lead'), ['ana', 'ben'])
    assert.deepEqual(directTargets(['ana', 'lead'], 'lead'), [])
    assert.deepEqual(directTargets([], 'lead'), [])
    assert.deepEqual(directTargets(['ana', 'ana'], 'lead'), ['ana'])
    assert.deepEqual(directTargets(['ana'], undefined), ['ana'])
  })

  it('labels the send button with who receives it', () => {
    assert.equal(sendLabel([], 'Atlas'), 'Ask @Atlas')
    assert.equal(sendLabel(['Ana'], 'Atlas'), 'Send to @Ana')
    assert.equal(sendLabel(['Ana', 'Ben'], 'Atlas'), 'Send to @Ana, @Ben')
    assert.equal(sendLabel(['Ana', 'Ben', 'Copy Editor', 'Dana'], 'Atlas'), 'Send to @Ana, @Ben +2')
  })

  it('gives each agent a stable chip colour', () => {
    for (const id of ['lead', 'ana', 'agt_0123456789abcdef', '']) {
      const tone = mentionTone(id)
      assert.ok(Number.isInteger(tone) && tone >= 0 && tone < MENTION_TONES, id)
      assert.equal(mentionTone(id), tone)
    }
    // Different ids spread over the tones.
    assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(mentionTone)).size > 2)
  })
})
