/* Optional per-endpoint HTTP(S) proxy (BE feat/endpoint-proxy). Pure helpers, tested in tests/endpoint-proxy.test.mjs. */

export const PROXY_URL_HINT = 'Optional HTTP proxy, like http://localhost:1055. Leave blank for a direct connection.'

/** Error message for a proxy URL field value, or null when valid (blank is valid: no proxy). */
export function validateProxyUrl(value: string): string | null {
  const v = value.trim()
  if (!v) return null
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return 'Must be a valid URL, e.g. http://localhost:1055.'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Must start with http:// or https://.'
  if (!url.hostname) return 'Must include a host, e.g. http://localhost:1055.'
  return null
}

/**
 * The `proxyUrl` part of an endpoint create/update body. Create: send only when set.
 * Update: omit when unchanged (BE keeps it), null when cleared, else the new value.
 */
export function proxyUrlPatch(value: string, stored: string | undefined, isEdit: boolean): { proxyUrl?: string | null } {
  const v = value.trim()
  if (!isEdit) return v ? { proxyUrl: v } : {}
  if (v === (stored ?? '')) return {}
  return { proxyUrl: v || null }
}
