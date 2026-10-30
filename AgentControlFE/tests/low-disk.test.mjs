import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lowDiskText, lowDiskTextOf, freeGbText, BROWSER_DOWNLOAD_BYTES, RUN_FLOOR_BYTES } from '../src/lib/low-disk.ts'

const GB = 1024 ** 3
const MOCKUP = 'The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.'

describe('low-disk sentence (Charles 2026-10-30)', () => {
  it('under 1.3 GB free: the mockup 09 sentence with the real figure', () => {
    assert.equal(lowDiskText({ freeBytes: 0.6 * GB }), MOCKUP)
    assert.equal(lowDiskText({ freeBytes: 0 }), MOCKUP.replace('0.6', '0.0'))
    assert.match(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES - 1 }), /^The download needs about 1\.3 GB and this computer has 1\.3 GB free\./)
  })
  it('between 1.3 and 4.3 GB free: the floor sentence with the real figure', () => {
    assert.equal(
      lowDiskText({ freeBytes: 2.5 * GB }),
      'The download needs about 1.3 GB, plus 3 GB kept free for runs, and this computer has 2.5 GB free. Free some space, then try again.',
    )
    assert.match(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES }), /plus 3 GB kept free for runs, and this computer has 1\.3 GB free/)
    assert.match(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES + RUN_FLOOR_BYTES - 1 }), /plus 3 GB kept free for runs, and this computer has 4\.3 GB free/)
  })
  it('neededBytes from the body sets the edge', () => {
    assert.match(lowDiskText({ freeBytes: 1.5 * GB, neededBytes: 2 * GB }), /^The download needs about 1\.3 GB and this/)
  })
  it('at or above download + floor, reused, or no figure: null (the server message shows)', () => {
    assert.equal(lowDiskText({ freeBytes: BROWSER_DOWNLOAD_BYTES + RUN_FLOOR_BYTES }), null)
    assert.equal(lowDiskText({ freeBytes: 2 * GB, reused: true }), null)
    assert.equal(lowDiskText({}), null)
    assert.equal(lowDiskText({ freeBytes: 'x' }), null)
    assert.equal(lowDiskText({ freeBytes: -1 }), null)
    assert.equal(lowDiskText(null), null)
  })
  it('lowDiskTextOf reads only reason low_disk', () => {
    assert.equal(lowDiskTextOf({ reason: 'low_disk', freeBytes: 0.6 * GB }), MOCKUP)
    assert.equal(lowDiskTextOf({ reason: 'build_active', freeBytes: 0.6 * GB }), null)
    assert.equal(lowDiskTextOf(undefined), null)
  })
  it('free figure rounds down', () => {
    assert.equal(freeGbText(2.59 * GB), '2.5 GB')
    assert.equal(freeGbText(0), '0.0 GB')
  })
})
