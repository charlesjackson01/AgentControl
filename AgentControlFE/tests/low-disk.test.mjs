import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lowDiskText, lowDiskTextOf, freeGbText, BROWSER_DOWNLOAD_BYTES, RUN_FREE_FLOOR_BYTES, LOW_DISK_TEXT } from '../src/lib/low-disk.ts'

const GiB = 1024 ** 3
const MOCKUP = 'The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.'
const FLOOR = 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 2.5 GB free.'

describe('low-disk sentences (contract fec4670, Charles + Team lead 2026-10-30)', () => {
  it('free < the download: the mockup 09 sentence with the real figure', () => {
    assert.equal(lowDiskText({ freeBytes: 0.6 * GiB }), MOCKUP)
    assert.equal(lowDiskText({ freeBytes: 0 }), MOCKUP.replace('0.6', '0.0'))
    assert.match(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES - 1 }), /^The download needs about 1\.3 GB and this computer has 1\.2 GB free\./)
  })
  it('download ≤ free < download + floor: the 2nd sentence exactly, no "Free some space" ending', () => {
    assert.equal(lowDiskText({ freeBytes: 2.5 * GiB }), FLOOR)
    assert.match(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES }), /and this computer has 1\.2 GB free\.$/)
    assert.match(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES + RUN_FREE_FLOOR_BYTES - 1 }), /plus 3 GB kept free for runs, and this computer has 4\.2 GB free\.$/)
  })
  it('compares in bytes; neededBytes from the body sets the edge', () => {
    assert.equal(BROWSER_DOWNLOAD_BYTES, 1343 * 1000 ** 2)
    assert.equal(RUN_FREE_FLOOR_BYTES, 3 * GiB)
    assert.match(lowDiskText({ freeBytes: 1.5 * GiB, neededBytes: 2 * GiB }), /^The download needs about 1\.3 GB and this/)
  })
  it('reused: only the floor counts; under it M1\'s run-floor text', () => {
    assert.equal(lowDiskText({ freeBytes: 2 * GiB, reused: true }), LOW_DISK_TEXT)
    assert.equal(lowDiskText({ freeBytes: 0.5 * GiB, reused: true }), LOW_DISK_TEXT)
    assert.equal(lowDiskText({ freeBytes: RUN_FREE_FLOOR_BYTES, reused: true }), null)
  })
  it('enough space, or no figure: null (the server message shows)', () => {
    assert.equal(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES + RUN_FREE_FLOOR_BYTES }), null)
    assert.equal(lowDiskText({}), null)
    assert.equal(lowDiskText({ freeBytes: 'x' }), null)
    assert.equal(lowDiskText({ freeBytes: -1 }), null)
    assert.equal(lowDiskText(null), null)
  })
  it('lowDiskTextOf reads only reason low_disk', () => {
    assert.equal(lowDiskTextOf({ reason: 'low_disk', freeBytes: 0.6 * GiB }), MOCKUP)
    assert.equal(lowDiskTextOf({ reason: 'build_active', freeBytes: 0.6 * GiB }), null)
    assert.equal(lowDiskTextOf(undefined), null)
  })
  it('free figure: 1024³ units, rounded down', () => {
    assert.equal(freeGbText(2.59 * GiB), '2.5 GB')
    assert.equal(freeGbText(0), '0.0 GB')
  })
})
