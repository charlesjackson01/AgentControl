import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import {
  MAX_UPLOAD_BYTES, ancestorsOf, baseName, breadcrumb, canModify, canWriteInto, checkPath, fileContentPath, fileIcon,
  fileSize, fileWhen, filesApi, filesErrorMessage, filesPanelOpen, filesPathParam, folderLine, imageLine, isImage,
  fileTarget, joinPath, nameError, filesTotal, latestSubfolder, paneView, parentOf, treeEntries, treeSize, uploadError, usageView, withFilesPath, zoneBadge, zoneOfPath,
} from '../src/lib/files.ts'
import { SETTINGS_TABS } from '../src/lib/settings-tabs.ts'

const NOW = new Date(2026, 9, 20, 15, 0)
const today = new Date(2026, 9, 20, 9, 30).toISOString()
const oct14 = new Date(2026, 9, 14, 12).toISOString()
const oct12 = new Date(2026, 9, 12, 12).toISOString()
const e = (path, over = {}) => ({
  path, name: baseName(path), kind: 'file', size: 1000, modifiedAt: today, zone: zoneOfPath(path) ?? 'meta', ...over,
})

describe('files: path guard (client copy of BE-2)', () => {
  it('accepts relative paths, drops a trailing slash, root is ""', () => {
    assert.deepEqual(checkPath('shared/site-photos/'), { ok: true, path: 'shared/site-photos' })
    assert.deepEqual(checkPath(''), { ok: true, path: '' })
    assert.deepEqual(checkPath(null), { ok: true, path: '' })
    assert.deepEqual(checkPath('BOT.md'), { ok: true, path: 'BOT.md' })
  })
  it('refuses traversal, absolute, backslash, empty segments and control characters', () => {
    for (const bad of ['shared/../x', '..', '../etc/passwd', 'shared/./a', 'shared//a', '/etc', 'C:/x', 'shared\\..\\x', 'a\u0000b', 'a\nb', 7, 'x'.repeat(1025)]) {
      const r = checkPath(bad)
      assert.equal(r.ok, false, `refuses ${JSON.stringify(bad)}`)
      assert.equal(typeof r.error, 'string')
    }
    assert.match(checkPath('shared/../x').error, /inside the bot folder/)
  })
  it('names for New folder / Rename / upload', () => {
    assert.equal(nameError('notes.md'), null)
    assert.match(nameError('  '), /Enter a name/)
    assert.match(nameError('..'), /not allowed/)
    assert.match(nameError('a/b'), /cannot contain/)
    assert.match(nameError('a\u0001'), /control/)
    assert.match(nameError('x'.repeat(256)), /too long/)
  })
  it('join/parent/base', () => {
    assert.equal(joinPath('', 'shared'), 'shared')
    assert.equal(joinPath('shared', 'a.png'), 'shared/a.png')
    assert.equal(parentOf('shared/a/b.png'), 'shared/a')
    assert.equal(parentOf('shared'), '')
    assert.equal(baseName('shared/a/b.png'), 'b.png')
    assert.deepEqual(ancestorsOf('shared/a/b'), ['shared', 'shared/a', 'shared/a/b'])
    assert.deepEqual(ancestorsOf(''), [])
  })
})

describe('files: zones (03d)', () => {
  it('zones by first segment; BOT.md is meta', () => {
    assert.equal(zoneOfPath('shared/x'), 'shared')
    assert.equal(zoneOfPath('skills/web/SKILL.md'), 'skills')
    assert.equal(zoneOfPath('BOT.md'), 'meta')
    assert.equal(zoneOfPath('elsewhere'), null)
  })
  it('only shared/ and workspace/ are writable; zone roots cannot be renamed or deleted', () => {
    assert.equal(canWriteInto('shared'), true)
    assert.equal(canWriteInto('workspace/briefs'), true)
    for (const ro of ['', 'memory', 'skills', 'skills/web', 'BOT.md']) assert.equal(canWriteInto(ro), false, ro)
    assert.equal(canModify('shared/a.png'), true)
    assert.equal(canModify('shared'), false)
    assert.equal(canModify('skills/web/SKILL.md'), false)
    assert.equal(canModify('memory/index.md'), false)
  })
  it('badges: workspace "scripts write" (green), memory/BOT.md "managed", skills "read-only", shared none', () => {
    assert.deepEqual(zoneBadge({ path: 'workspace' }), { label: 'scripts write', tone: 'green' })
    assert.deepEqual(zoneBadge({ path: 'memory' }), { label: 'managed', tone: 'neutral' })
    assert.deepEqual(zoneBadge({ path: 'BOT.md' }), { label: 'managed', tone: 'neutral' })
    assert.deepEqual(zoneBadge({ path: 'skills' }), { label: 'read-only', tone: 'neutral' })
    assert.equal(zoneBadge({ path: 'shared' }), null)
    assert.equal(zoneBadge({ path: 'workspace/briefs' }), null)
  })
  it('icons: 🖼 images, 📕 pdf, 📊 sheets, 📄 rest', () => {
    assert.equal(fileIcon(e('shared/a.PNG')), '🖼')
    assert.equal(fileIcon(e('shared/a.bin', { mime: 'image/webp' })), '🖼')
    assert.equal(fileIcon(e('shared/plan.pdf')), '📕')
    assert.equal(fileIcon(e('shared/budget.csv')), '📊')
    assert.equal(fileIcon(e('shared/notes.txt')), '📄')
    assert.equal(isImage(e('shared/pics', { kind: 'dir' })), false)
    assert.equal(isImage(e('shared/x.png', { mime: 'text/plain' })), false)
  })
})

describe('files: tree and right pane', () => {
  const root = ['BOT.md', 'memory', 'shared', 'skills', 'workspace'].map((p) => e(p, { kind: p === 'BOT.md' ? 'file' : 'dir' }))
  it('root in 03d order (BE-2 sorts by name)', () => {
    assert.deepEqual(treeEntries('', root).map((x) => x.path), ['shared', 'workspace', 'memory', 'skills', 'BOT.md'])
    assert.deepEqual(paneView(root, '').folders.map((x) => x.path), ['shared', 'workspace', 'memory', 'skills'])
  })
  const shared = [
    e('shared/site-photos', { kind: 'dir', modifiedAt: oct14 }),
    e('shared/budget-q4.csv', { modifiedAt: oct12 }),
    e('shared/harbor-notes.txt', { modifiedAt: today }),
    e('shared/logo.png', { mime: 'image/png', modifiedAt: oct12 }),
    e('shared/sketch.png', { mime: 'image/png', modifiedAt: today }),
  ]
  it('shared/ is newest first in the tree and the pane; images, folders and files split', () => {
    assert.deepEqual(treeEntries('shared', shared).map((x) => x.name), ['harbor-notes.txt', 'sketch.png', 'site-photos', 'budget-q4.csv', 'logo.png'])
    const v = paneView(shared, 'shared')
    assert.deepEqual(v.images.map((x) => x.name), ['sketch.png', 'logo.png'])
    assert.deepEqual(v.folders.map((x) => x.name), ['site-photos'])
    assert.deepEqual(v.files.map((x) => x.name), ['harbor-notes.txt', 'budget-q4.csv'])
  })
  it('elsewhere keeps BE order in the tree and names in the pane; search filters by name', () => {
    const ws = [e('workspace/todo.md'), e('workspace/briefs', { kind: 'dir' })]
    assert.deepEqual(treeEntries('workspace', ws).map((x) => x.name), ['todo.md', 'briefs'])
    assert.deepEqual(paneView(ws, 'workspace').files.map((x) => x.name), ['todo.md'])
    assert.deepEqual(paneView(shared, 'shared', ' HARBOR ').files.map((x) => x.name), ['harbor-notes.txt'])
    assert.deepEqual(paneView(shared, 'shared', 'zzz'), { images: [], folders: [], files: [] })
  })
  it('lines: image size·date, folder "9 items · sent Oct 14", file date (sent in chat with BE-9 sharedAt)', () => {
    assert.equal(imageLine(e('shared/a.png', { size: 412 * 1024 }), NOW), '412 KB · Today')
    assert.equal(folderLine(shared[0], 9, NOW), '9 items · sent Oct 14')
    assert.equal(folderLine(e('workspace/briefs', { kind: 'dir', modifiedAt: oct14 }), 1, NOW), '1 item · Oct 14')
    assert.equal(folderLine(shared[0], undefined, NOW), 'sent Oct 14')
    assert.equal(fileWhen(e('shared/a.pdf', { sharedAt: today }), NOW), 'sent in chat · Today')
    assert.equal(fileWhen(e('shared/a.pdf', { modifiedAt: oct12 }), NOW), 'Oct 12')
    assert.equal(fileSize(e('shared/a.pdf', { size: 2.4 * 1024 * 1024 })), '2.4 MB')
  })
  it('tree sizes: whole units, none on shared/ files or folders', () => {
    assert.equal(treeSize(e('workspace/briefs/x.md', { size: 2300 })), '2 KB')
    assert.equal(treeSize(e('shared/a.pdf', { size: 2300 })), '')
    assert.equal(treeSize(e('workspace/briefs', { kind: 'dir' })), '')
  })
  it('usage bar "46 MB of 500 MB"', () => {
    assert.deepEqual(usageView({ bytes: 46 * 1024 * 1024, quotaBytes: 500 * 1024 * 1024 }), { label: '46 MB of 500 MB', percent: 9.2, valueText: '46 MB of 500 MB' })
    assert.equal(usageView({ bytes: 900, quotaBytes: 100 }).percent, 100)
    assert.equal(usageView(null), null)
    assert.equal(usageView({ bytes: 1, quotaBytes: 0 }), null)
  })
  it('breadcrumb starts at the bot slug', () => {
    assert.deepEqual(breadcrumb('primary', 'shared/site-photos'), [
      { label: 'primary', path: '' }, { label: 'shared', path: 'shared' }, { label: 'site-photos', path: 'shared/site-photos' },
    ])
    assert.deepEqual(breadcrumb('primary', ''), [{ label: 'primary', path: '' }])
  })
})

describe('files: upload limits and error messages', () => {
  it('25 MiB is the limit; one byte over is refused with a clear message', () => {
    assert.equal(MAX_UPLOAD_BYTES, 26214400)
    assert.equal(uploadError({ name: 'ok.bin', size: MAX_UPLOAD_BYTES }), null)
    assert.equal(uploadError({ name: 'big.mov', size: 40 * 1024 * 1024 }), '"big.mov" is over the 25 MB upload limit (40 MB).')
    assert.match(uploadError({ name: 'big.mov', size: MAX_UPLOAD_BYTES + 1 }), /over the 25 MB upload limit/)
  })
  it('Fastify body-limit 413 -> 25 MB message; quota 413, 403, 400, 409 keep the server text', () => {
    assert.equal(filesErrorMessage(413, 'Request body is too large', 'big.mov'), '"big.mov" is over the 25 MB upload limit.')
    assert.equal(filesErrorMessage(413, null), 'That file is over the 25 MB upload limit.')
    const quota = 'This would put the bot folder over its 1 MiB limit.'
    assert.equal(filesErrorMessage(413, quota, 'a.png'), quota)
    const ro = '"path" must be inside shared/ or workspace/; the rest of the bot folder is read-only.'
    assert.equal(filesErrorMessage(403, ro), ro)
    assert.equal(filesErrorMessage(403, null), 'That part of the bot folder is read-only.')
    assert.equal(filesErrorMessage(400, '"path" must not contain empty, "." or ".." segments.'), '"path" must not contain empty, "." or ".." segments.')
    assert.equal(filesErrorMessage(404, null), 'That file or folder no longer exists.')
    assert.equal(filesErrorMessage(500, null), 'Something went wrong with the files request.')
  })
})

describe('files: URL', () => {
  const P = (s) => new URLSearchParams(s)
  it('?panel=files opens the Files tab at ?path= (default shared)', () => {
    assert.equal(filesPanelOpen(P('panel=files&path=workspace')), true)
    assert.equal(filesPanelOpen(P('panel=settings&tab=files')), false)
    assert.equal(filesPathParam(P('panel=files&path=workspace/briefs')), 'workspace/briefs')
    assert.equal(filesPathParam(P('panel=files')), 'shared')
    assert.equal(filesPathParam(P('panel=settings&tab=files&path=memory')), 'shared')
    assert.equal(filesPathParam(P('panel=files&path=shared/../x')), 'shared/../x', 'raw; FilesTab refuses it')
  })
  it('browsing sets panel=files&path, drops tab, keeps other keys', () => {
    assert.equal(withFilesPath(P('panel=settings&tab=files&m=9'), 'shared/site-photos').toString(), 'panel=files&m=9&path=shared%2Fsite-photos')
  })
  it('Sandbox tab stays, disabled as coming soon; Files is live', () => {
    assert.equal(SETTINGS_TABS.find((t) => t.id === 'sandbox').comingSoon, true)
    assert.equal(SETTINGS_TABS.find((t) => t.id === 'files').comingSoon, undefined)
  })
})

describe('files: API (BE-2 c2257b1)', () => {
  const calls = []
  const request = async (path, init) => (calls.push({ path, init }), { ok: 1 })
  const uploads = []
  let reply = { ok: true, status: 201, json: async () => ({ path: 'shared/a.png' }) }
  const upload = async (url, body) => (uploads.push({ url, body }), reply)
  const api = filesApi(request, upload, (b) => (b && typeof b.error === 'string' ? b.error : null))
  it('routes and bodies', async () => {
    await api.list('a 1', 'shared/site photos')
    await api.makeFolder('a1', 'shared/new')
    await api.move('a1', 'shared/a', 'shared/b')
    await api.remove('a1', 'shared/b')
    assert.deepEqual(calls.map((c) => [c.init?.method ?? 'GET', c.path, c.init?.body]), [
      ['GET', '/api/agents/a%201/files?path=shared%2Fsite+photos', undefined],
      ['POST', '/api/agents/a1/files/folders', '{"path":"shared/new"}'],
      ['PATCH', '/api/agents/a1/files', '{"from":"shared/a","to":"shared/b"}'],
      ['DELETE', '/api/agents/a1/files?path=shared%2Fb', undefined],
    ])
    assert.equal(fileContentPath('a1', 'shared/a b.pdf'), '/api/agents/a1/files/content?path=shared%2Fa+b.pdf')
    assert.equal(fileContentPath('a1', 'shared/a.pdf', true), '/api/agents/a1/files/content?path=shared%2Fa.pdf&download=1')
  })
  it('upload PUTs the raw file into the folder', async () => {
    const out = await api.upload('a1', 'shared', { name: 'a.png', size: 10 })
    assert.deepEqual(out, { path: 'shared/a.png' })
    assert.equal(uploads.at(-1).url, '/api/agents/a1/files/content?path=shared%2Fa.png')
  })
  it('over 25 MiB or a bad name never reaches the server', async () => {
    const before = uploads.length
    await assert.rejects(api.upload('a1', 'shared', { name: 'big.mov', size: MAX_UPLOAD_BYTES + 1 }), (err) => err.status === 413 && /25 MB/.test(err.message))
    await assert.rejects(api.upload('a1', 'shared', { name: '..', size: 1 }), (err) => err.status === 400)
    assert.equal(uploads.length, before)
  })
  it('server errors surface their message (quota 413, 403) or the 25 MB text (Fastify 413)', async () => {
    reply = { ok: false, status: 413, json: async () => ({ error: 'This would put the bot folder over its 1 MiB limit.' }) }
    await assert.rejects(api.upload('a1', 'shared', { name: 'a.png', size: 10 }), { status: 413, message: 'This would put the bot folder over its 1 MiB limit.' })
    reply = { ok: false, status: 413, json: async () => ({ error: 'Request body is too large' }) }
    await assert.rejects(api.upload('a1', 'shared', { name: 'a.png', size: 10 }), { message: '"a.png" is over the 25 MB upload limit.' })
    reply = { ok: false, status: 403, json: async () => { throw new Error('not json') } }
    await assert.rejects(api.upload('a1', 'skills', { name: 'a.png', size: 10 }), { status: 403, message: 'That part of the bot folder is read-only.' })
  })
})

describe('files: tree auto-expand (03d workspace/briefs)', () => {
  const ws = [
    e('workspace/briefs', { kind: 'dir', modifiedAt: oct12 }),
    e('workspace/drafts', { kind: 'dir', modifiedAt: oct12 }),
    e('workspace/todo.md', { modifiedAt: today }),
  ]
  it('workspace/: the subfolder holding the newest file opens (03d: briefs/, drafts/ stays shut)', () => {
    const kids = {
      'workspace/briefs': { entries: [e('workspace/briefs/lindmere-harbor.md', { modifiedAt: today })] },
      'workspace/drafts': { entries: [e('workspace/drafts/intro.md', { modifiedAt: oct14 })] },
    }
    assert.equal(latestSubfolder('workspace', ws, kids), 'workspace/briefs')
    kids['workspace/drafts'].entries.push(e('workspace/drafts/new.md', { modifiedAt: new Date(2026, 9, 20, 10).toISOString() }))
    assert.equal(latestSubfolder('workspace', ws, kids), 'workspace/drafts', 'follows the latest work, not a fixed name')
  })
  it('falls back to folder mtimes, ties go by name; no subfolders -> none', () => {
    assert.equal(latestSubfolder('workspace', ws, {}), 'workspace/briefs')
    assert.equal(latestSubfolder('workspace', [e('workspace/a', { kind: 'dir', modifiedAt: oct12 }), e('workspace/b', { kind: 'dir', modifiedAt: oct14 })], {}), 'workspace/b')
    assert.equal(latestSubfolder('workspace', [e('workspace/todo.md')], {}), null)
  })
  it('only workspace/: shared/ keeps site-photos collapsed (03d)', () => {
    assert.equal(latestSubfolder('shared', [e('shared/site-photos', { kind: 'dir' })], {}), null)
    assert.equal(latestSubfolder('workspace/briefs', ws, {}), null)
  })
})

describe('files: GAP-F2 tab count from optional totalFiles', () => {
  it('present and valid -> the number ("Files 31"), whatever folder the listing is for', () => {
    assert.equal(filesTotal({ entries: [], totalFiles: 31 }), 31)
    assert.equal(filesTotal({ path: 'workspace/briefs', entries: [e('workspace/briefs/a.md')], totalFiles: 31 }), 31, 'whole folder, not the open one')
    assert.equal(filesTotal({ totalFiles: 0 }), 0)
  })
  it('missing or invalid -> no count (as with c2257b1)', () => {
    for (const bad of [{ entries: [] }, { totalFiles: null }, { totalFiles: '31' }, { totalFiles: -1 }, { totalFiles: 2.5 }, { totalFiles: NaN }, { totalFiles: Infinity }, null, undefined, 31]) {
      assert.equal(filesTotal(bad), undefined, JSON.stringify(bad))
    }
  })
})

describe('FE-7 Open target (?path=<file>)', () => {
  const listing = { entries: [
    { path: 'workspace/briefs/lindmere-harbor.md', name: 'lindmere-harbor.md', kind: 'file' },
    { path: 'workspace/briefs/old', name: 'old', kind: 'folder' },
  ] }
  it('a file in its folder\'s listing is a file target (open the folder, pick out the file)', () => {
    assert.equal(fileTarget(listing, 'workspace/briefs/lindmere-harbor.md'), true)
  })
  it('a folder, an unknown path or an unlisted parent is not', () => {
    assert.equal(fileTarget(listing, 'workspace/briefs/old'), false)
    assert.equal(fileTarget(listing, 'workspace/briefs/nope.md'), false)
    assert.equal(fileTarget(undefined, 'workspace/briefs/lindmere-harbor.md'), false)
  })
  it('FilesTab lists the parent first and only lists ?path itself when it is not a file (no 400)', () => {
    const tab = readFileSync(new URL('../src/components/settings/FilesTab.tsx', import.meta.url), 'utf8')
    assert.match(tab, /if \(target !== '' && !fileTarget\(loadedRef\.current\[parentOf\(target\)\], target\)\) await load\(target\)/)
    assert.match(tab, /const path = fileHit \? parentOf\(target\) : target/)
  })
})

describe('FE-4 dialogs: server errors stay in the dialog', () => {
  const tab = readFileSync(new URL('../src/components/settings/FilesTab.tsx', import.meta.url), 'utf8')
  it('Rename / New folder route errors into the dialog with role=alert and keep it open', () => {
    assert.match(tab, /const shown = error \?\? serverError \?\? null/)
    assert.match(tab, /\{shown && <p className="field__err" id="cf-files-name-err" role="alert">\{shown\}<\/p>\}/)
    assert.match(tab, /if \(!done\) requestAnimationFrame\(\(\) => inputRef\.current\?\.focus\(\)\)/)
    assert.equal((tab.match(/, true\)\n/g) ?? []).length >= 2, true, 'both makeFolder and rename act(…, inDialog=true)')
  })
})

describe('FE-4 layout: narrow panels reflow, 1280/1440 untouched', () => {
  const css = readFileSync(new URL('../src/shell.css', import.meta.url), 'utf8')
  it('container query on the Files tab, below the 1280 width (Files ≈611 px there)', () => {
    assert.match(css, /\.cf-files \{[^}]*container: cf-files \/ inline-size;/)
    const m = css.match(/@container cf-files \(max-width: (\d+)px\)/g) ?? []
    assert.equal(m.length, 1)
    assert.ok(Number(m[0].match(/(\d+)px/)[1]) < 611)
  })
})
