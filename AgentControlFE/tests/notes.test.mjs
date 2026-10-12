import assert from 'node:assert/strict'
import { it } from 'node:test'
import { filterNotes } from '../src/lib/notes.ts'

const notes = [
  { id: 'new', title: 'Planning', snippet: 'Launch on Friday', authorName: 'Team Lead', authorAgentId: 'a1', tags: ['Release'] },
  { id: 'old', title: 'Research', snippet: '<script>untrusted</script>', authorName: null, authorAgentId: 'deleted-agent', tags: [] },
]

it('searches the displayed fields without losing the server update order', () => {
  assert.deepEqual(filterNotes(notes, '  '), notes)
  for (const q of ['planning', ' FRIDAY ', 'release', 'Team Lead', 'a1']) assert.deepEqual(filterNotes(notes, q), [notes[0]])
  assert.deepEqual(filterNotes(notes, 'deleted-agent'), [notes[1]])
  assert.deepEqual(filterNotes(notes, 'missing'), [])
  assert.deepEqual(filterNotes([], 'query'), [])
})
