import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { humanSize, relativeTime } from '../src/lib/file-format.ts'

describe('humanSize (mockups 04, 03d, 06c)', () => {
  it('matches the mockup sizes', () => {
    assert.equal(humanSize(1024), '1 KB')
    assert.equal(humanSize(2458), '2.4 KB')
    assert.equal(humanSize(412 * 1024), '412 KB')
    assert.equal(humanSize(1.8 * 1024 * 1024), '1.8 MB')
    assert.equal(humanSize(2 * 1024 * 1024), '2 MB')
    assert.equal(humanSize(46 * 1024 * 1024), '46 MB')
    assert.equal(humanSize(500 * 1024 * 1024), '500 MB')
  })
  it('edges', () => {
    assert.equal(humanSize(0), '0 B')
    assert.equal(humanSize(1023), '1023 B')
    assert.equal(humanSize(10189), '10 KB', '9.95 KB rounds up to 10 KB, not "10.0 KB"')
    assert.equal(humanSize(1024 * 1024 - 1), '1 MB')
    assert.equal(humanSize(25 * 1024 * 1024), '25 MB')
    assert.equal(humanSize(3 * 1024 ** 3), '3 GB')
  })
  it('bad values → null', () => {
    for (const v of [-1, NaN, Infinity, '12', null, undefined, {}]) assert.equal(humanSize(v), null, String(v))
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-10-20T17:00:00Z')
  it('"just now" under a minute (mockup 04), small clock skew included', () => {
    assert.equal(relativeTime('2026-10-20T16:59:30Z', now), 'just now')
    assert.equal(relativeTime('2026-10-20T17:01:00Z', now), 'just now')
  })
  it('minutes and hours within a day', () => {
    assert.equal(relativeTime('2026-10-20T16:59:00Z', now), '1 min ago')
    assert.equal(relativeTime('2026-10-20T16:01:00Z', now), '59 min ago')
    assert.equal(relativeTime('2026-10-20T16:00:00Z', now), '1 h ago')
    assert.equal(relativeTime('2026-10-19T17:00:01Z', now), '23 h ago')
  })
  it('older → "Oct 12" (03d), with the year when it differs', () => {
    assert.equal(relativeTime('2026-10-12T17:00:00Z', now), 'Oct 12')
    assert.equal(relativeTime('2025-03-02T17:00:00Z', now), 'Mar 2, 2025')
  })
  it('bad values → null; far future → null', () => {
    for (const v of ['', 'yesterday', 12, null, undefined]) assert.equal(relativeTime(v, now), null, String(v))
    assert.equal(relativeTime('2026-10-21T17:00:00Z', now), null)
  })
})
