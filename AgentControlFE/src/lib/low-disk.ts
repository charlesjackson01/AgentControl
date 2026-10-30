/*
 * The browser low-disk sentences (contract fec4670, turn-on flow step 1; Charles + Team lead 2026-10-30),
 * shared by the /new card (FE-P2-7, 409 low_disk), the browser permission card (FE-P2-3, setup error) and the
 * VM tab's browser row (FE-P2-10, setup error; browserLowDiskText):
 * - free < the download (1343 MB): the mockup 09 sentence;
 * - download ≤ free < download + the 3 GB run floor: the 2nd sentence, exactly as written (no "Free some space…");
 * - download already here (`reused`): only the floor counts; under it, M1's run-floor text (LOW_DISK_TEXT);
 * - no free-space figure: null, and the caller shows the server's `message` (which carries the same text).
 * Sizes compare in bytes; the free figure is bytes ÷ 1024³, one decimal, rounded down; the download stays "about 1.3 GB".
 * Pure; tests/low-disk.test.mjs.
 */
import type { BrowserError } from './types.ts'

/** BE SHARED_IMAGE_APPROX_BYTES['botvm-browser'] (vm-images.ts @ fec4670): "about 1.3 GB". */
export const BROWSER_DOWNLOAD_BYTES = 1343 * 1000 ** 2
/** BE RUN_FREE_FLOOR_BYTES (run-service.ts @ fec4670). */
export const RUN_FREE_FLOOR_BYTES = 3 * 1024 ** 3
/** BE LOW_DISK_TEXT (run-service.ts @ fec4670): M1's run-floor text. */
export const LOW_DISK_TEXT = "This computer is almost out of disk space (less than 3 GB free), so scripts can't run until some space is freed."

/**
 * The low-disk figures: BrowserError's `freeBytes`/`neededBytes` and BrowserSetup.download.`reused`.
 * The 409 low_disk body at fec4670 defines none of them (only `message`); the FE reads the same names there
 * if the BE adds them (FE pick, flagged), and otherwise shows `message`.
 */
export type LowDiskFigures = { freeBytes?: unknown; neededBytes?: unknown; reused?: unknown }

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** "0.6 GB", "2.5 GB": bytes ÷ 1024³, one decimal, rounded down so it never overstates the space (below 0 reads "0.0 GB"). */
export function freeGbText(bytes: number): string {
  return `${(Math.floor((Math.max(0, bytes) / 1024 ** 3) * 10) / 10).toFixed(1)} GB`
}

export function lowDiskText(f: LowDiskFigures | null | undefined): string | null {
  if (!f || typeof f !== 'object') return null
  const free = num(f.freeBytes)
  if (free === undefined) return null
  if (f.reused === true) return free < RUN_FREE_FLOOR_BYTES ? LOW_DISK_TEXT : null
  const needed = num(f.neededBytes) ?? BROWSER_DOWNLOAD_BYTES
  const has = freeGbText(free)
  if (free < needed) return `The download needs about 1.3 GB and this computer has ${has} free. Free some space, then try again.`
  if (free < needed + RUN_FREE_FLOOR_BYTES) return `The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has ${has} free.`
  return null
}

/** A 409 body (or a BrowserError) with reason low_disk → the sentence; anything else → null. */
export function lowDiskTextOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as LowDiskFigures & { reason?: unknown }
  return b.reason === 'low_disk' ? lowDiskText(b) : null
}

/**
 * FE-P2-10 (VM tab browser row, BrowserError low_disk): the server's message first, else the sentence from its
 * `freeBytes` (a figure below 0 counts as 0), else M1's floor text. `reused`: BrowserSetup.download.reused.
 */
export function browserLowDiskText(e: Pick<BrowserError, 'message' | 'freeBytes'> | undefined, reused = false): string {
  if (e?.message?.trim()) return e.message.trim()
  const free = typeof e?.freeBytes === 'number' ? Math.max(0, e.freeBytes) : undefined
  return (free !== undefined ? lowDiskText({ freeBytes: free, reused }) : null) ?? LOW_DISK_TEXT
}
