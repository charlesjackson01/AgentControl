import { describe, expect, it } from 'vitest'
import { isApiRequest, pathVariants } from './api-path.js'

describe('isApiRequest (BE-P2-13 review B1)', () => {
  it('matches the routed path and every decoding level of the raw one', () => {
    for (const url of ['/api/agents', '/api', '/%61pi/agents', '/%2561pi', '/%252561pi/x', '//api/x', '/./api/x', '/a/../api/x', '/API/x', '/%41pi/x', '/api%2fagents', '\\api/x']) {
      expect([url, isApiRequest({ url })]).toEqual([url, true])
    }
    expect(isApiRequest({ url: '/whatever', routeOptions: { url: '/api/agents/:id' } })).toBe(true)
  })
  it('leaves other paths alone', () => {
    for (const url of ['/health', '/', '/apix', '/static/api/x', '/%zz', '/index.html?u=/api/x']) expect([url, isApiRequest({ url })]).toEqual([url, false])
  })
  it('a malformed escape does not throw', () => {
    expect(() => pathVariants('/%E0%A4%A/%61pi')).not.toThrow()
    expect(isApiRequest({ url: '/%E0%A4%A/../%61pi/x' })).toBe(true)
  })
})
