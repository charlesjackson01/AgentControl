/* Pure: the agent form's optional Temperature field (BE-4 af197cd/e2221c8). tests/temperature.test.mjs
 *
 * Blank means "Endpoint default": nothing stored, the endpoint/model decides.
 * - Create: blank omits the key; a value is sent (POST saves it since e2221c8).
 * - Edit: unchanged sends nothing; blank where a value was stored sends
 *   `temperature: null` via PATCH (clears it); a new value is PATCHed.
 * - Validation only when something is entered: 0–2.
 */

export const TEMPERATURE_PLACEHOLDER = 'Endpoint default'
export const TEMPERATURE_ERROR = 'Set temperature between 0 and 2, or leave it blank for the endpoint default.'

/** Field text for a stored value: blank when none is stored. */
export function temperatureText(stored: number | null | undefined): string {
  return typeof stored === 'number' && Number.isFinite(stored) ? String(stored) : ''
}

/** Null for blank; the number when valid; an error otherwise. */
export function parseTemperature(text: string): { value: number | null; error: string | null } {
  const t = text.trim()
  if (t === '') return { value: null, error: null }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0 || n > 2) return { value: null, error: TEMPERATURE_ERROR }
  return { value: n, error: null }
}

/** Create body field: blank omits `temperature`. Call after validation. */
export function createTemperatureField(text: string): { temperature?: number } {
  const { value, error } = parseTemperature(text)
  return error || value === null ? {} : { temperature: value }
}

/**
 * Edit: the PATCH body for the temperature, or null when there is nothing to send
 * (unchanged, or blank with nothing stored). Call after validation.
 */
export function editTemperaturePatch(stored: number | null | undefined, text: string): { temperature: number | null } | null {
  const { value, error } = parseTemperature(text)
  if (error) return null
  const had = typeof stored === 'number' ? stored : null
  if (value === had) return null
  return { temperature: value }
}
