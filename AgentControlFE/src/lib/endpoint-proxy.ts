/* Optional per-endpoint proxy: HTTP(S) (BE feat/endpoint-proxy) or SOCKS5 (BE-11). Pure helpers, tested in tests/endpoint-proxy.test.mjs. */

export const PROXY_URL_HINT = 'Optional HTTP or SOCKS5 proxy, like http://localhost:1055 or socks5://localhost:1055. Leave blank for a direct connection.'

/** Schemes the BE can dial through. socks5h:// resolves hostnames on the proxy. */
export const PROXY_PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:'] as const

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
  if (!(PROXY_PROTOCOLS as readonly string[]).includes(url.protocol)) return 'Must start with http://, https://, socks5:// or socks5h://.'
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
