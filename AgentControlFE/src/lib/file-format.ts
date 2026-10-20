/*
 * Sizes and times for file cards and the Files tab, in the v3 mockups' format:
 * "2.4 KB", "412 KB", "1.8 MB", "2 MB" (04, 03d, 06c) and "updated just now" (04).
 * Pure; tests/file-format.test.mjs.
 */

const UNITS = ['KB', 'MB', 'GB', 'TB']

/** Human size: one decimal under 10 (dropping ".0"), whole numbers from 10 up. Null for bad values. */
export function humanSize(bytes: unknown): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  if (v < 10) {
    const r = Math.round(v * 10) / 10
    // 9.96 KB rounds to 10.0 → "10 KB".
    return r >= 10 ? `10 ${UNITS[i]}` : `${String(r)} ${UNITS[i]}`
  }
  const whole = Math.round(v)
  return whole >= 1024 && i < UNITS.length - 1 ? `1 ${UNITS[i + 1]}` : `${whole} ${UNITS[i]}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Relative time for "updated …": "just now" (mockup 04) under a minute, then
 * "5 min ago", "3 h ago" within a day, else "Oct 12" (03d's date style; year
 * added when it differs). Only "just now" is in v3; the rest follow it neutrally.
 * Null for bad values. A time slightly in the future (clock skew) counts as just now.
 */
export function relativeTime(iso: unknown, now: Date = new Date()): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const s = (now.getTime() - t) / 1000
  if (s < 60) return s > -300 ? 'just now' : null
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = new Date(t)
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? day : `${day}, ${d.getFullYear()}`
}

/** Tree sizes in 03d are whole numbers ("2 KB", "1 KB"). Null for bad values. */
export function wholeSize(bytes: unknown): string | null {
  const h = humanSize(bytes)
  if (!h) return null
  const [n, unit] = h.split(' ')
  return `${Math.max(Number(n) < 1 ? 0 : 1, Math.round(Number(n)))} ${unit}`
}

/** Dates in 03d's file lists: "Today", "Oct 12" (year added when it differs). Null for bad values. */
export function shortDate(iso: unknown, now: Date = new Date()): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  if (d.toDateString() === now.toDateString()) return 'Today'
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? day : `${day}, ${d.getFullYear()}`
}
