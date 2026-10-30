/*
 * The low-disk sentence for turning the browser on (Charles, 2026-10-30), shared by the /new card
 * (FE-P2-7, 409 low_disk) and the browser permission card (FE-P2-3, setup error low_disk):
 * - under the download size free (about 1.3 GB): the mockup 09 sentence;
 * - between that and the download plus the 3 GB run floor (about 4.3 GB): the floor sentence;
 * - download already on this computer (reused): only the floor counts, and neither sentence fits, so
 *   the server's own message shows (null here);
 * - no free-space figure: null (the caller shows the server's message, as before).
 * Pure; tests/low-disk.test.mjs.
 */

const GiB = 1024 ** 3
/** SHARED_IMAGE_APPROX_BYTES.browser (1343 MB): "about 1.3 GB". */
export const BROWSER_DOWNLOAD_BYTES = 1343 * 1024 ** 2
/** The run floor kept free on top of a download (plan, BE-P2-15 turn-on step 1). */
export const RUN_FLOOR_BYTES = 3 * GiB

/**
 * The low-disk figures. Field names follow BrowserError (neededBytes, freeBytes) and
 * BrowserSetup.download.reused. FE pick for the 409 body: the contract doesn't define them there yet.
 */
export type LowDiskFigures = { freeBytes?: unknown; neededBytes?: unknown; reused?: unknown }

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** "0.6 GB", "2.5 GB": one decimal, rounded down so the figure is never more than what's free. */
export function freeGbText(bytes: number): string {
  return `${(Math.floor((bytes / GiB) * 10) / 10).toFixed(1)} GB`
}

export function lowDiskText(f: LowDiskFigures | null | undefined): string | null {
  if (!f || typeof f !== 'object') return null
  const free = num(f.freeBytes)
  if (free === undefined || f.reused === true) return null
  const needed = num(f.neededBytes) ?? BROWSER_DOWNLOAD_BYTES
  const has = freeGbText(free)
  if (free < needed) return `The download needs about 1.3 GB and this computer has ${has} free. Free some space, then try again.`
  if (free < needed + RUN_FLOOR_BYTES)
    return `The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has ${has} free. Free some space, then try again.`
  return null
}

/** A 409 body (or a BrowserError) with reason low_disk → the sentence; anything else → null. */
export function lowDiskTextOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as LowDiskFigures & { reason?: unknown }
  return b.reason === 'low_disk' ? lowDiskText(b) : null
}
