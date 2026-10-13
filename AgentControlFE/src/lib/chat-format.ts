/** Turn divider time: "14:05" today, "Oct 3, 14:05" on other days. */
export function turnTime(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
}

/** The server's message, or a plain hint when the API server is unreachable. */
export function friendlyError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : fallback
  return msg === 'Failed to fetch' || msg === 'fetch failed'
    ? 'Could not reach the API server. Is the backend running?'
    : msg
}
