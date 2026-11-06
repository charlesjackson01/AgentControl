/*
 * FE-P2-6: Settings › VMs talks to the live /api only.
 *
 * Demo data (vms-fake.ts) loads only when this process was started with VITE_VMS_FAKE=1
 * (`VITE_VMS_FAKE=1 npm run dev`, or the same variable in `.env.local`). Unset, a missing
 * route (404 "Route …"), a dead proxy, and an empty 5xx reject like any other error.
 * Vite inlines the comparison, so a production build without the variable never bundles the fake.
 */
import { request } from './api.ts'

export async function vmsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (import.meta.env.VITE_VMS_FAKE === '1') {
    const { vmsRequestWith } = await import('./vms-fallback.ts')
    return vmsRequestWith<T>(path, init, request, '1')
  }
  return request<T>(path, init)
}
