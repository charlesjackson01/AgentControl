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

/** BE-11 masks a stored proxy password as `***` on every read; sending it back keeps the stored one. */
export const PROXY_PASSWORD_MASK = '***'

/** True when the proxy URL carries the masked password (as GET /api/endpoints returns it). */
export function isMaskedProxy(value: string): boolean {
  try {
    return new URL(value.trim()).password === PROXY_PASSWORD_MASK
  } catch {
    return false
  }
}

export const MASKED_PROXY_HINT =
  'The saved password shows as ***. Leaving *** keeps it only for the same scheme, username, host and port; change any of those and type the password again.'

/**
 * scheme://user@host:port as the URL parser gives it: exactly what BE-11 compares
 * before keeping a password (http(s) hosts come lowercased, socks5 hosts as typed).
 */
function proxyTarget(value: string): string | null {
  try {
    const u = new URL(value.trim())
    return `${u.protocol}//${u.username}@${u.hostname}:${u.port}`
  } catch {
    return null
  }
}

/**
 * Warning shown before saving: the field still holds *** but the scheme, username,
 * host or port changed (BE-11 then answers 400 "Re-enter the proxy password for the new host"),
 * or there's no saved proxy for *** to stand for. Null when fine.
 */
export function maskedProxyWarning(value: string, loaded: string | undefined): string | null {
  if (!isMaskedProxy(value)) return null
  if (!loaded || !isMaskedProxy(loaded)) return 'There is no saved password for *** to keep. Type the proxy password.'
  const now = proxyTarget(value)
  const was = proxyTarget(loaded)
  return now !== was ? 'The scheme, username, host or port changed, so *** no longer stands for the saved password. Type the proxy password again.' : null
}

export type EndpointTestResult = { ok: boolean; models: string[]; latencyMs: number; error?: string }

/** The line under an endpoint after Test: models on success, BE-11's `error` cause on failure. */
export function endpointTestNote(res: EndpointTestResult): string {
  if (res.ok) return `Reachable · ${res.latencyMs}ms · [${res.models.join(', ')}]`
  const why = typeof res.error === 'string' ? res.error.trim() : ''
  return why ? `Unreachable · ${why}` : 'Unreachable'
}
