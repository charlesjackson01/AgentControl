// FE-P2-6: files_missing (BE be-6 409 on file routes; VM state files_missing) in the Files and VM tabs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FILES_MISSING_TEXT, filesMissingOf, paneDrop, sharedHint } from '../src/lib/files.ts'
// Same shape as lib/api.ts ApiError (api.ts itself isn't loadable under strip-types).
class ApiError extends Error { constructor(m, status, body) { super(m); this.status = status; this.body = body } }
import { vmHeader, vmTabModel } from '../src/lib/vm-tab.ts'
import { renderVmTab } from '../src/lib/vm-tab-render.ts'
import { NOW, macHost, probeResult, vmInfo } from './vm-fixtures.mjs'

const BE6 = "AgentControl can't find the bots' files, so files and runs are paused to keep anything from being overwritten. Chats still work."
const body409 = { statusCode: 409, error: 'Request Error', message: BE6, reason: 'files_missing' }
const text = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ')

describe('files_missing: Files tab', () => {
  it('reads the server message from a 409 files_missing ApiError', () => {
    assert.equal(filesMissingOf(new ApiError(BE6, 409, body409)), BE6)
    assert.equal(filesMissingOf(new ApiError('x', 409, { ...body409, message: 'Server says so.' })), 'Server says so.')
    assert.equal(filesMissingOf(new ApiError('x', 409, { reason: 'files_missing' })), FILES_MISSING_TEXT)
    assert.equal(FILES_MISSING_TEXT, BE6, 'fallback is be-6 wording')
  })
  it('other errors are not files_missing', () => {
    assert.equal(filesMissingOf(new ApiError('busy', 409, { reason: 'run_active', message: 'busy' })), null)
    assert.equal(filesMissingOf(new ApiError(BE6, 404, body409)), null)
    assert.equal(filesMissingOf(new Error('x')), null)
    assert.equal(filesMissingOf(null), null)
  })
  it('no "Drop files here…" hint in files_missing (bot and group)', () => {
    assert.match(sharedHint({ group: false, ownerName: 'Analyst', filesMissing: false }), /^Drop files here, or send them in chat/)
    assert.equal(sharedHint({ group: false, ownerName: 'Analyst', filesMissing: true }), null)
    assert.equal(sharedHint({ group: true, ownerName: 'Q3', filesMissing: true }), null)
  })
  it('drops are refused (no highlight, no upload) in files_missing; non-file drags ignored', () => {
    assert.equal(paneDrop(['Files'], false), 'accept')
    assert.equal(paneDrop(['Files'], true), 'refuse')
    assert.equal(paneDrop(['text/plain'], true), 'ignore')
    assert.equal(paneDrop(undefined, false), 'ignore')
  })
  it('FilesTab wires the guard: hint via sharedHint, upload only on accept, no drop class while missing', () => {
    const src = readFileSync(new URL('../src/components/settings/FilesTab.tsx', import.meta.url), 'utf8')
    assert.doesNotMatch(src, /`Drop files here/, 'hint text only comes from sharedHint')
    assert.match(src, /filesMissing: missing !== null/)
    assert.match(src, /if \(how === 'accept'\) void upload\(e\.dataTransfer\.files\)/)
    assert.match(src, /dragging && !missing \? ' cf-files__pane--drop'/)
    assert.match(src, /const gone = filesMissingOf\(err\)/)
  })
})

describe('files_missing: VM tab', () => {
  const model = (vm) => vmTabModel({ vm, botName: 'Analyst', host: macHost(), probe: probeResult(), groupNames: {}, now: NOW })
  const ui = { busy: null, errors: {}, editor: null, hasMore: false, exportHref: '/api/agents/analyst/export' }
  it('renders the server message as the banner, not an FE string', () => {
    const vm = vmInfo({ state: 'files_missing', stateMessage: BE6 })
    assert.equal(vmHeader(vm, 'Analyst', 'mac', NOW).banner, BE6)
    const out = text(renderToStaticMarkup(renderVmTab(model(vm), ui)))
    assert.ok(out.includes(BE6))
    assert.doesNotMatch(out, /The bot's files folder is missing/)
    assert.doesNotMatch(out, /files aren't where AgentControl keeps them/)
    const other = vmInfo({ state: 'files_missing', stateMessage: 'Something else from the server.' })
    assert.equal(vmHeader(other, 'Analyst', 'mac', NOW).banner, 'Something else from the server.')
  })
  it('no stateMessage: be-6 wording, same as the file routes', () => {
    assert.equal(vmHeader(vmInfo({ state: 'files_missing' }), 'Analyst', 'mac', NOW).banner, BE6)
    assert.equal(vmHeader(vmInfo({ state: 'files_missing', stateMessage: '  ' }), 'Analyst', 'mac', NOW).banner, BE6)
  })
  it('internet choice, Re-check now and Add variable stay active', () => {
    const html = renderToStaticMarkup(renderVmTab(model(vmInfo({ state: 'files_missing', stateMessage: BE6 })), ui))
    for (const label of ['Re-check now', 'Add variable']) {
      const m = html.match(new RegExp(`<button[^>]*>${label}</button>`))
      assert.ok(m, label)
      assert.doesNotMatch(m[0], /disabled/, `${label} enabled`)
    }
    const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? []
    assert.ok(radios.length >= 2)
    for (const r of radios) assert.doesNotMatch(r, /disabled=""/)
  })
})
