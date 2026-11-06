/*
 * Lists the screenshots this run wrote. Comparison against a golden image is intentionally
 * not a failure: the M3 plan keeps screenshot diffs as artifacts, not a hard gate, at first.
 * There is no committed baseline, so this file records the artifact names only.
 */
import fs from 'node:fs'

export default function teardown() {

const dir = 'e2e/artifacts'
fs.mkdirSync(dir, { recursive: true })
const screenshots = fs.readdirSync(dir).filter((name) => name.endsWith('.png')).sort()
const manifest = {
  gated: false,
  note: 'Screenshot diffs are artifacts, not a pass/fail gate.',
  screenshots,
}
fs.writeFileSync(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
}
