import { expect, test } from './support'

/**
 * Opt-in @vm smoke. Skipped unless AC_VM_TESTS=1.
 * `npm run e2e` does not set that variable, and the CI Playwright job does not either.
 * This spec never starts podman itself: it only asks a host the caller pointed at
 * (AC_VM_API, default http://127.0.0.1:3001, which is not the fake runner on :3099).
 */
test('VM host answers @vm', async ({ request }) => {
  test.skip(process.env.AC_VM_TESTS !== '1', 'Opt-in only. Set AC_VM_TESTS=1. Not part of the default suite or CI.')
  const base = process.env.AC_VM_API ?? 'http://127.0.0.1:3001'
  const res = await request.get(`${base}/api/vm/host`, { timeout: 5_000 })
  expect(res.ok(), `${base}/api/vm/host`).toBeTruthy()
  const host = (await res.json()) as { engine?: unknown }
  expect(host.engine).toBeTruthy()
})
