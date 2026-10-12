import type { NoteSummary } from './types'

/** The list endpoint returns a snippet, so search covers only displayed metadata. */
export function filterNotes(notes: NoteSummary[], query: string): NoteSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return notes
  return notes.filter((note) => [note.title, note.snippet, note.authorName ?? '', note.authorAgentId, ...note.tags]
    .some((value) => value.toLowerCase().includes(q)))
}
