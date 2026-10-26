// FE-7 × BE-3 (5d5a864): top-level run filesChanged, BE-3 step lines, usage with trash, "Nothing at" 404s.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { activityView, runFilesChanged } from '../src/lib/activity.ts'
import { filesErrorMessage, usageView } from '../src/lib/files.ts'
import { errorMessageFrom } from '../src/lib/api-error.ts'

const now = new Date('2026-10-26T19:00:00Z')
const written = { path: 'workspace/notes/todo.md', change: 'added', bytes: 2458, modifiedAt: '2026-10-26T18:59:40Z' }

describe('runFilesChanged: the run\'s top-level list only', () => {
  it('returns the top-level array, [] included', () => {
    assert.deepEqual(runFilesChanged({ id: 'r', status: 'failed', filesChanged: [written] }), [written])
    assert.deepEqual(runFilesChanged({ id: 'r', status: 'succeeded', filesChanged: [] }), [])
  })
  it('never falls back to run.activity.filesChanged', () => {
    assert.equal(runFilesChanged({ id: 'r', activity: { steps: [], filesChanged: [written] } }), null)
    assert.equal(runFilesChanged({ id: 'r', filesChanged: 'x' }), null)
    assert.equal(runFilesChanged(null), null)
  })
})

describe('activityView with the run\'s top-level filesChanged', () => {
  const stale = { skills: [], steps: [], filesChanged: [{ path: 'workspace/old.md', change: 'modified' }] }
  it('top-level list replaces the message copy (bytes + modifiedAt in the card meta)', () => {
    const v = activityView(stale, now, [written])
    assert.deepEqual(v.files.map((f) => [f.path, f.meta]), [['workspace/notes/todo.md', 'workspace/notes · 2.4 KB · updated just now']])
  })
  it('an empty top-level list means no file cards even if the message has some', () => {
    assert.equal(activityView(stale, now, []), null)
  })
  it('a failed run that changed a file: cards with no message activity at all', () => {
    const v = activityView(undefined, now, [written])
    assert.equal(v.card, false)
    assert.equal(v.files.length, 1)
  })
  it('without a top-level list the message activity is still shown (chat messages carry no top-level field)', () => {
    assert.equal(activityView(stale, now).files[0].path, 'workspace/old.md')
  })
})

describe('BE-3 step lines read as the server wrote them', () => {
  const steps = (list) => activityView({ skills: [], steps: list, filesChanged: [] }, now).steps.map((s) => [s.verb, s.target, s.summary, s.ok])
  it('refused write: "Couldn\'t write memory/x.md", never "Wrote …"', () => {
    assert.deepEqual(steps([{ tool: 'write_file', summary: "Couldn't write memory/x.md", ok: false, path: 'memory/x.md' }]), [["Couldn't write", 'memory/x.md', '', false]])
  })
  it('good write / read / folder / list without a path', () => {
    assert.deepEqual(
      steps([
        { tool: 'write_file', summary: 'Created workspace/notes/todo.md', ok: true, path: 'workspace/notes/todo.md' },
        { tool: 'read_file', summary: 'Read shared/brief.md', ok: true, path: 'shared/brief.md' },
        { tool: 'make_folder', summary: 'Made folder workspace/a', ok: true, path: 'workspace/a' },
        { tool: 'list_files', summary: 'Listed files', ok: true },
        { tool: 'list_files', summary: "Couldn't list files", ok: false },
      ]),
      [
        ['Created', 'workspace/notes/todo.md', '', true],
        ['Read', 'shared/brief.md', '', true],
        ['Made folder', 'workspace/a', '', true],
        ['Listed files', null, '', true],
        ["Couldn't list files", null, '', false],
      ],
    )
  })
  it('BE-7 / mockup 04 summaries keep verb + target + summary', () => {
    assert.deepEqual(steps([{ tool: 'read_file', summary: 'pages 6–9', ok: true, path: 'shared/harbor-plan-2026.pdf' }]), [['Read', 'shared/harbor-plan-2026.pdf', 'pages 6–9', true]])
    assert.deepEqual(steps([{ tool: 'convert_units', summary: '240 ft → 73.2 m', ok: true }]), [['Ran', 'convert_units', '240 ft → 73.2 m', true]])
  })
})

describe('Files tab usage includes trash (BE-3)', () => {
  it('label is bytes (trash included) of quota; valueText names the trash part', () => {
    const u = usageView({ bytes: 3 * 1024 * 1024, quotaBytes: 500 * 1024 * 1024, trashBytes: 1024 * 1024 })
    assert.equal(u.label, '3 MB of 500 MB')
    assert.equal(u.valueText, '3 MB of 500 MB, including 1 MB in trash')
    assert.equal(usageView({ bytes: 1024, quotaBytes: 2048, trashBytes: 0 }).valueText, '1 KB of 2 KB')
  })
  it('the meter carries valueText', () => {
    assert.match(readFileSync(new URL('../src/components/settings/FilesTab.tsx', import.meta.url), 'utf8'), /aria-valuetext=\{usage\.valueText\}/)
  })
})

describe('missing paths show the server\'s 404 wording as is', () => {
  const msg = 'Nothing at "workspace/gone.md" in this bot\'s files.'
  it('JSON error bodies (list, move, delete)', () => {
    assert.equal(errorMessageFrom({ error: msg }), msg)
    assert.equal(errorMessageFrom({ error: 'Not Found', message: msg }), msg)
  })
  it('upload path', () => {
    assert.equal(filesErrorMessage(404, msg), msg)
  })
})
