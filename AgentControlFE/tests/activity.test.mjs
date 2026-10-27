import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { MAX_STEPS, activityLabel, activityView, canOpenFile, fileOpenPath, stepVerb } from '../src/lib/activity.ts'

const mockup04 = {
  skills: [{ id: 'obra/systematic-debugging', name: 'systematic-debugging', source: 'obra/superpowers' }],
  steps: [
    { tool: 'read_file', summary: 'pages 6–9', ok: true, path: 'shared/harbor-plan-2026.pdf' },
    { tool: 'convert_units', summary: '240 ft → 73.2 m', ok: true },
    { tool: 'edit_file', summary: '+3 −3', ok: true, path: 'workspace/briefs/lindmere-harbor.md' },
  ],
  filesChanged: [{ path: 'workspace/briefs/lindmere-harbor.md', change: 'modified' }],
}

describe('activity card: rendering from activity (mockup 04)', () => {
  const v = activityView(mockup04)
  it('header: Skill pill, name, source, step count', () => {
    assert.equal(v.card, true)
    assert.equal(v.pill, 'Skill')
    assert.equal(v.title, 'systematic-debugging')
    assert.equal(v.source, 'obra/superpowers')
    assert.equal(v.count, '3 steps')
    assert.equal(v.expandable, true)
  })
  it('steps: verb + mono target + summary, as in "Read shared/… pages 6–9", "Ran convert_units"', () => {
    assert.deepEqual(v.steps.map((s) => [s.verb, s.target, s.summary, s.ok]), [
      ['Read', 'shared/harbor-plan-2026.pdf', 'pages 6–9', true],
      ['Ran', 'convert_units', '240 ft → 73.2 m', true],
      ['Edited', 'workspace/briefs/lindmere-harbor.md', '+3 −3', true],
    ])
    assert.equal(v.failed, 0)
  })
  it('file cards: name, folder, change', () => {
    assert.deepEqual(v.files, [{ path: 'workspace/briefs/lindmere-harbor.md', name: 'lindmere-harbor.md', dir: 'workspace/briefs', change: 'modified', changeLabel: 'modified', size: null, updated: null, meta: 'workspace/briefs · modified' }])
    assert.equal(activityView({ skills: [], steps: [], filesChanged: [{ path: 'notes.md', change: 'added' }] }).files[0].dir, '')
  })
  it('one step reads "1 step"; the toggle label names skill, count and failures', () => {
    const one = activityView({ ...mockup04, steps: [{ tool: 'read_file', summary: '', ok: false, path: 'a.md' }] })
    assert.equal(one.count, '1 step')
    assert.equal(activityLabel(one), 'Skill systematic-debugging, 1 step, 1 failed')
    assert.equal(activityLabel(v), 'Skill systematic-debugging, 3 steps')
  })
  it('unknown tools read "Ran <tool>", known tools use their verb and path', () => {
    assert.deepEqual(stepVerb('csv_summary'), { verb: 'Ran', target: 'csv_summary' })
    assert.deepEqual(stepVerb('compare_text'), { verb: 'Compared', target: null }, 'mockup 04 "Compared pier length: …"')
    assert.deepEqual(stepVerb('activate_skill'), { verb: 'Activated skill', target: null })
    assert.deepEqual(stepVerb('read_skill_file', 'scripts/x.py'), { verb: 'Read skill file', target: 'scripts/x.py' })
  })
})

describe('file cards: BE-3 bytes/modifiedAt (GAP-6 resolved)', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  const file = (extra) => activityView({ skills: [], steps: [], filesChanged: [{ path: 'workspace/briefs/lindmere-harbor.md', change: 'modified', ...extra }] }, now).files[0]
  it('both present → mockup 04 "workspace/briefs · 2.4 KB · updated just now"', () => {
    assert.equal(file({ bytes: 2458, modifiedAt: '2026-10-20T11:59:40Z' }).meta, 'workspace/briefs · 2.4 KB · updated just now')
  })
  it('older times and bigger sizes', () => {
    assert.equal(file({ bytes: 421888, modifiedAt: '2026-10-20T11:55:00Z' }).meta, 'workspace/briefs · 412 KB · updated 5 min ago')
    assert.equal(file({ bytes: 1887437, modifiedAt: '2026-10-20T09:00:00Z' }).meta, 'workspace/briefs · 1.8 MB · updated 3 h ago')
  })
  it('only one present → that one, no change word', () => {
    assert.equal(file({ bytes: 2458 }).meta, 'workspace/briefs · 2.4 KB')
    assert.equal(file({ modifiedAt: '2026-10-20T11:59:40Z' }).meta, 'workspace/briefs · updated just now')
  })
  it('absent → today\'s "folder · modified"; top-level file has no folder', () => {
    assert.equal(file({}).meta, 'workspace/briefs · modified')
    assert.equal(activityView({ skills: [], steps: [], filesChanged: [{ path: 'notes.md', change: 'added', bytes: 1024 }] }, now).files[0].meta, '1 KB')
  })
  it('bad values are ignored and fall back', () => {
    for (const extra of [{ bytes: -1 }, { bytes: '2458' }, { bytes: NaN }, { bytes: Infinity }, { modifiedAt: 'yesterday' }, { modifiedAt: 12 }, { modifiedAt: '' }, { bytes: null, modifiedAt: null }, { modifiedAt: '2026-10-21T12:00:00Z' }]) {
      assert.equal(file(extra).meta, 'workspace/briefs · modified', JSON.stringify(extra))
    }
  })
})

describe('activity card: empty or missing activity hides it', () => {
  for (const [name, a] of [['undefined', undefined], ['null', null], ['string', 'x'], ['array', []], ['all empty', { skills: [], steps: [], filesChanged: [] }], ['no keys', {}]]) {
    it(`${name} → null`, () => assert.equal(activityView(a), null))
  }
  it('only malformed entries → null', () => {
    assert.equal(activityView({ skills: [{ id: 1 }], steps: [{ tool: 'x' }], filesChanged: [{ path: 'a', change: 'renamed' }] }), null) // Phase 2: 'deleted' is valid now (see below)
  })
})

describe('activity card: malformed entries are ignored', () => {
  it('keeps the valid ones and drops the rest', () => {
    const v = activityView({
      skills: [null, 'core/x', { id: 'a/x', name: 'x' }, { id: 'a/y', name: 'y', source: 'a' }, { id: 'a/y', name: 'y', source: 'a' }],
      steps: [{ tool: '', summary: 's', ok: true }, { tool: 't', summary: 1, ok: true }, { tool: 't', summary: 's', ok: 'yes' }, { tool: 'read_file', summary: 's', ok: true, path: 5 }],
      filesChanged: [{ path: '', change: 'added' }, { path: 'x.md' }, { path: 'dir/y.md', change: 'added' }, 7],
    })
    assert.deepEqual(v.skills, [{ id: 'a/y', name: 'y', source: 'a' }], 'invalid and duplicate skills dropped')
    assert.equal(v.steps.length, 1)
    assert.equal(v.steps[0].target, null, 'non-string path ignored')
    assert.deepEqual(v.files.map((f) => f.path), ['dir/y.md'])
  })
  it('non-array lists are treated as empty', () => {
    const v = activityView({ skills: mockup04.skills, steps: 'nope', filesChanged: { path: 'x' } })
    assert.equal(v.steps.length, 0)
    assert.equal(v.files.length, 0)
  })
  it(`keeps at most ${MAX_STEPS} steps`, () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({ tool: 'read_file', summary: `s${i}`, ok: true }))
    const v = activityView({ skills: [], steps, filesChanged: [] })
    assert.equal(v.steps.length, 20)
    assert.equal(v.steps.at(-1).summary, 's19')
    assert.equal(v.count, '20 steps')
  })
})

describe('activity card: failed steps', () => {
  it('a failed step is marked and counted for screen readers, not in the visible count (GAP-1)', () => {
    const v = activityView({ ...mockup04, steps: [...mockup04.steps, { tool: 'write_file', summary: 'permission denied', ok: false, path: 'x.md' }] })
    assert.equal(v.failed, 1)
    assert.equal(v.steps.at(-1).ok, false)
    assert.equal(v.count, '4 steps')
    assert.match(activityLabel(v), /1 failed$/)
  })
})

describe('activity card: gap states (minimal, pending approval)', () => {
  it('GAP-3 one skill, no steps: header only, not expandable', () => {
    const v = activityView({ skills: mockup04.skills, steps: [], filesChanged: [] })
    assert.equal(v.card, true)
    assert.equal(v.expandable, false)
    assert.equal(v.count, '')
  })
  it('GAP-4 steps only: no pill or title', () => {
    const v = activityView({ skills: [], steps: mockup04.steps, filesChanged: [] })
    assert.equal(v.pill, null)
    assert.equal(v.title, null)
    assert.equal(v.count, '3 steps')
    assert.equal(activityLabel(v), '3 steps')
  })
  it('GAP-5 several skills: names joined, no single source, expandable for the sources', () => {
    const v = activityView({ skills: [...mockup04.skills, { id: 'core/summarization', name: 'summarization', source: 'core' }], steps: [], filesChanged: [] })
    assert.equal(v.title, 'systematic-debugging, summarization')
    assert.equal(v.source, null)
    assert.equal(v.expandable, true)
  })
  it('GAP-9 files only: no skill card, file cards only', () => {
    const v = activityView({ skills: [], steps: [], filesChanged: mockup04.filesChanged })
    assert.equal(v.card, false)
    assert.equal(v.files.length, 1)
  })
})

describe('activity card: component wiring', () => {
  const src = readFileSync(new URL('../src/components/shell/MessageActivity.tsx', import.meta.url), 'utf8')
  it('toggle is a button with aria-expanded and aria-controls; collapsed by default', () => {
    assert.match(src, /useState\(false\)/)
    assert.match(src, /<button\s+type="button"\s+className="cf-act__head"\s+aria-expanded=\{open\}\s+aria-controls=\{bodyId\}/)
    assert.match(src, /hidden=\{!open\}/)
    const css = readFileSync(new URL('../src/shell.css', import.meta.url), 'utf8')
    assert.match(css, /\.cf-act__body\[hidden\] \{ display: none; \}/, 'display:flex must not override hidden')
  })
  it('Open links to the Files panel at the file (GAP-7 resolved); still no Download', () => {
    assert.match(src, /<Link className="cf-btn cf-fcard__open" to=\{fileOpenPath\(conversationId, f\.path\)\}/)
    assert.doesNotMatch(src, /cf-fcard__open" disabled/)
    assert.doesNotMatch(src, />\s*Download\s*</, "no Download action")
    const chat = readFileSync(new URL('../src/pages/ConversationChat.tsx', import.meta.url), 'utf8')
    assert.match(chat, /<FileCards files=\{act\.files\} conversationId=\{conversationId\} \/>/)
  })
  it('fileOpenPath opens this chat with ?panel=files&path=<file>', () => {
    assert.equal(fileOpenPath('conv-1', 'workspace/briefs/lindmere-harbor.md'), '/c/conv-1?panel=files&path=workspace%2Fbriefs%2Flindmere-harbor.md')
    assert.equal(fileOpenPath('c 2', 'shared/a b.txt'), '/c/c%202?panel=files&path=shared%2Fa+b.txt')
    const qs = new URLSearchParams(fileOpenPath('x', 'shared/site-photos/p.png').split('?')[1])
    assert.equal(qs.get('panel'), 'files')
    assert.equal(qs.get('path'), 'shared/site-photos/p.png')
  })
  it('ConversationChat puts the card above the bubble and file cards below it', () => {
    const chat = readFileSync(new URL('../src/pages/ConversationChat.tsx', import.meta.url), 'utf8')
    // FE-5 moved BotRow/UserRow into components/shell/ChatRows.tsx (shared with the /new draft card).
    const rows = readFileSync(new URL('../src/components/shell/ChatRows.tsx', import.meta.url), 'utf8')
    assert.match(rows, /\{before\}\s*\n\s*<div className=\{`cf-bub cf-bub--a/)
    assert.match(rows, /\{after\}\s*\n\s*\{meta &&/)
    assert.match(chat, /activityView\(m\.activity, undefined, \(m\.runId && runFiles\[m\.runId\]\) \|\| null\)/)
  })
})

describe("file cards: Phase 2 'deleted' (BE-P2-1)", () => {
  const now = new Date('2026-10-27T12:00:00Z')
  it('keeps a deleted file with "folder · deleted" and nothing to open', () => {
    const v = activityView({ skills: [], steps: [], filesChanged: [
      { path: 'workspace/old.csv', change: 'deleted', bytes: 10, modifiedAt: '2026-10-27T11:59:00Z' },
      { path: 'workspace/new.csv', change: 'added', bytes: 2048 },
    ] }, now)
    assert.deepEqual(v.files[0], { path: 'workspace/old.csv', name: 'old.csv', dir: 'workspace', change: 'deleted', changeLabel: 'deleted', size: null, updated: null, meta: 'workspace · deleted' })
    assert.equal(canOpenFile(v.files[0]), false)
    assert.equal(canOpenFile(v.files[1]), true)
  })
  it('still drops unknown change kinds', () => {
    assert.equal(activityView({ skills: [], steps: [], filesChanged: [{ path: 'x', change: 'renamed' }] }), null)
  })
})

