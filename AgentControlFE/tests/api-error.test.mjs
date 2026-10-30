import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_ERROR_MESSAGE, errorMessageFrom, isGenericError } from '../src/lib/api-error.ts'

describe('API error text', () => {
  it("prefers message when error is the BE's generic 'Request Error'", () => {
    assert.equal(errorMessageFrom({ statusCode: 400, error: 'Request Error', message: 'Provide a "content" string.' }), 'Provide a "content" string.')
    assert.equal(errorMessageFrom({ statusCode: 500, error: 'Internal Server Error', message: 'upstream exploded' }), 'upstream exploded')
  })
  it('uses a specific contract error ({ error })', () => {
    assert.equal(errorMessageFrom({ error: 'Projects were retired; see /api/archive/projects' }), 'Projects were retired; see /api/archive/projects')
    assert.equal(errorMessageFrom({ error: 'Name taken', message: 'other' }), 'Name taken')
  })
  it("keeps Fastify's 404 'Route … not found' message (the send fallback depends on it)", () => {
    assert.equal(errorMessageFrom({ statusCode: 404, error: 'Not Found', message: 'Route GET:/api/search?q=x not found' }), 'Route GET:/api/search?q=x not found')
  })
  it('falls back to a generic error, then the default', () => {
    assert.equal(errorMessageFrom({ error: 'Request Error' }), 'Request Error')
    assert.equal(errorMessageFrom({ error: '  ', message: '' }), DEFAULT_ERROR_MESSAGE)
    assert.equal(errorMessageFrom(null), DEFAULT_ERROR_MESSAGE)
    assert.equal(errorMessageFrom('oops'), DEFAULT_ERROR_MESSAGE)
    assert.equal(errorMessageFrom({ error: 42, message: 'm' }), 'm')
  })
  it("FE-P2-7: a 409 'Conflict' low_disk (M2 ruling: no reasons on 5xx) defers to message", () => {
    assert.equal(errorMessageFrom({ statusCode: 409, error: 'Conflict', reason: 'low_disk', message: 'The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.' }),
      'The download needs about 1.3 GB and this computer has 0.6 GB free. Free some space, then try again.')
  })
  it("a bare 507 'Insufficient Storage' phrase is still generic (message wins)", () => {
    assert.equal(errorMessageFrom({ statusCode: 507, error: 'Insufficient Storage', message: 'm' }), 'm')
  })
  it('generic detection is case-insensitive', () => {
    assert.equal(isGenericError('request error'), true)
    assert.equal(isGenericError('Bad Request'), true)
    assert.equal(isGenericError('Name taken'), false)
  })
})
