/* Endpoint "Max reply tokens" (BE feat/max-output-tokens). Pure helpers, tested in tests/max-output-tokens.test.mjs. */

/** Server default reply budget (BE RESPONSE_RESERVE). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

export const MAX_OUTPUT_TOKENS_PLACEHOLDER = `${DEFAULT_MAX_OUTPUT_TOKENS} (default)`

export const MAX_OUTPUT_TOKENS_HINT = 'Tokens kept free for each reply (max_tokens). Blank uses the server default; must be below the context window.'

/** Inline error for the field, or null when valid. Blank is valid (default). */
export function validateMaxOutputTokens(value: string, contextWindow?: number): string | null {
  const v = value.trim()
  if (v === '') return null
  if (!/^\d+$/.test(v)) return 'Must be a whole number of tokens.'
  const n = Number(v)
  if (n <= 0) return 'Must be greater than 0.'
  if (contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0 && n >= contextWindow) {
    return `Must be less than the context window (${Math.floor(contextWindow).toLocaleString('en-US')}).`
  }
  return null
}

/** The `maxOutputTokens` part of an endpoint body. Create: only when set. Edit: only when changed; blank clears with null. */
export function maxOutputTokensPatch(value: string, stored: number | undefined | null, isEdit: boolean): { maxOutputTokens?: number | null } {
  const v = value.trim()
  const n = v === '' ? undefined : Number(v)
  if (!isEdit) return n !== undefined ? { maxOutputTokens: n } : {}
  if (n === (stored ?? undefined)) return {}
  return { maxOutputTokens: n ?? null }
}

/** Endpoint list suffix, e.g. " · reply 2048"; empty when unset. */
export function maxOutputTokensLabel(n: number | undefined | null): string {
  return typeof n === 'number' ? ` · reply ${n}` : ''
}
