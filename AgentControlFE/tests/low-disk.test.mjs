import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { browserLowDiskText, lowDiskText, lowDiskTextOf, freeGbText, BROWSER_DOWNLOAD_BYTES, RUN_FREE_FLOOR_BYTES, LOW_DISK_TEXT } from '../src/lib/low-disk.ts'
import * as vmTab from '../src/lib/vm-tab.ts'

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

// FE-P2-10's VM tab cases (were tests/vm-tab-m2.test.mjs "low disk"), on the shared code.
describe('low disk, VM tab browser row (FE-P2-10; contract fec4670; Charles 2026-10-30)', () => {
  const GB = 1024 ** 3
  const ld = (freeBytes, reused = false) => lowDiskText({ freeBytes, reused })
  it('constants: download 1343·1000², floor 3·1024³; vm-tab re-exports the shared ones', () => {
    assert.equal(BROWSER_DOWNLOAD_BYTES, 1_343_000_000)
    assert.equal(RUN_FREE_FLOOR_BYTES, 3 * GB)
    assert.equal(vmTab.BROWSER_DOWNLOAD_BYTES, BROWSER_DOWNLOAD_BYTES)
    assert.equal(vmTab.RUN_FREE_FLOOR_BYTES, RUN_FREE_FLOOR_BYTES)
    assert.equal(vmTab.LOW_DISK_TEXT, LOW_DISK_TEXT)
    assert.equal(vmTab.browserLowDiskText, browserLowDiskText)
  })
  it('free figure in 1024³ units, rounded down to one decimal', () => {
    assert.equal(freeGbText(2.59 * GB), '2.5 GB')
    assert.equal(freeGbText(2.99999 * GB), '2.9 GB')
    assert.equal(freeGbText(1.0 * GB), '1.0 GB')
    assert.equal(freeGbText(0), '0.0 GB')
    assert.equal(freeGbText(-5), '0.0 GB')
    assert.equal(freeGbText(4.3e9), '4.0 GB') // 4.3e9 bytes = 4.004… GiB
  })
  it('under the download: the mockup sentence, with its ending', () => {
    assert.equal(ld(BROWSER_DOWNLOAD_BYTES - 1), 'The download needs about 1.3 GB and this computer has 1.2 GB free. Free some space, then try again.')
  })
  it('download fits but not the floor: the floor sentence exactly, no ending', () => {
    assert.equal(ld(BROWSER_DOWNLOAD_BYTES), 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 1.2 GB free.')
    assert.equal(ld(BROWSER_DOWNLOAD_BYTES + RUN_FREE_FLOOR_BYTES - 1), 'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 4.2 GB free.')
    assert.doesNotMatch(ld(4 * GB), /Free some space/)
  })
  it('compared in bytes: exactly download + floor is enough', () => {
    assert.equal(ld(BROWSER_DOWNLOAD_BYTES + RUN_FREE_FLOOR_BYTES), null)
    assert.equal(ld(100 * GB), null)
  })
  it('a reused download checks the floor only, with M1 text', () => {
    assert.equal(ld(RUN_FREE_FLOOR_BYTES - 1, true), LOW_DISK_TEXT)
    assert.equal(ld(RUN_FREE_FLOOR_BYTES, true), null)
    assert.equal(ld(1 * GB, true), "This computer is almost out of disk space (less than 3 GB free), so scripts can't run until some space is freed.")
  })
  it('BrowserError low_disk: server message first, else from freeBytes, else M1', () => {
    assert.equal(browserLowDiskText({ message: ' Server says. ', freeBytes: 1 }), 'Server says.')
    assert.match(browserLowDiskText({ message: '', freeBytes: 2 * GB }), /plus 3 GB kept free for runs, and this computer has 2\.0 GB free\.$/)
    assert.equal(browserLowDiskText({ message: '', freeBytes: 2 * GB }, true), LOW_DISK_TEXT)
    assert.equal(browserLowDiskText(undefined), LOW_DISK_TEXT)
  })
  it('as before the fold-in: a figure below 0 reads 0.0 GB, a non-finite one falls back to M1', () => {
    assert.equal(browserLowDiskText({ message: '', freeBytes: -5 }), 'The download needs about 1.3 GB and this computer has 0.0 GB free. Free some space, then try again.')
    assert.equal(browserLowDiskText({ message: '', freeBytes: Number.NaN }), LOW_DISK_TEXT)
    assert.equal(browserLowDiskText({ message: '', freeBytes: Infinity }), LOW_DISK_TEXT)
  })
})
