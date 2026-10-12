/**
 * Output redaction applied to every tool result (ok or error) before it goes
 * back upstream — possibly to a hosted provider like OpenRouter. Exact secret
 * values are replaced with split/join (no regex built from secrets); common
 * key shapes are caught by bounded, anchor-free patterns that cannot backtrack.
 */
import type { WorkspaceStore } from '../store.js'

export const REDACTED = '[redacted]'

const KEY_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,200}/g, // OpenAI / OpenRouter (sk-or-v1-…)
  /ghp_[A-Za-z0-9]{20,100}/g, // GitHub personal access token
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
]

function exactSecrets(store: WorkspaceStore): string[] {
  const values = Object.values(store.endpointKeys ?? {})
  const token = process.env.AGENTCONTROL_AUTH_TOKEN
  if (token) values.push(token)
  // Longest first so a secret containing another is replaced whole.
  return values.filter((v) => typeof v === 'string' && v.length >= 8).sort((a, b) => b.length - a.length)
}

export function redactSecrets(text: string, store: WorkspaceStore): string {
  let out = text
  for (const secret of exactSecrets(store)) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}
