import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ATTACHMENTS, admitFiles, attachmentHref, attachmentMeta, attachmentOwner, attachmentsPreview, canSendWith, chipLine,
  dragHasFiles, fileBadge, groupSharedWhen, isImageAttachment, isPdfAttachment, liveChips, markSendFailure, newChip,
  oversizeText, readyAttachments, rejectedChip, sendFailureHint, sharedHere, uploadFailureText, uploadPath,
} from '../src/lib/attachments.ts'
import { previewText } from '../src/lib/conversations.ts'

const MiB = 1024 * 1024
const att = (name, extra = {}) => ({ root: 'agent', path: `shared/${name}`, name, size: 421888, mime: 'application/pdf', ...extra })
const done = (key, name, a = att(name)) => ({ ...newChip(key, { name, size: a.size, type: a.mime }), status: 'done', progress: 1, attachment: a })

describe('FE-7 attachments: admitting files', () => {
  it('rejects files over 25 MiB and keeps the rest', () => {
    const { accepted, rejected } = admitFiles([], [{ name: 'ok.pdf', size: 25 * MiB }, { name: 'big.mov', size: 25 * MiB + 1 }])
    assert.deepEqual(accepted.map((f) => f.name), ['ok.pdf'])
    assert.equal(rejected.length, 1)
    assert.match(rejected[0].error, /^"big\.mov" is over the 25 MB limit/)
    assert.match(oversizeText({ name: 'x', size: 30 * MiB }), /25 MB limit \(30/)
  })
  it('caps a message at 10 live files; failed chips do not count', () => {
    const chips = Array.from({ length: 9 }, (_, i) => done(`k${i}`, `f${i}.pdf`))
    chips.push(rejectedChip('bad', { name: 'bad.bin', size: 1 }, 'nope'))
    assert.equal(liveChips(chips).length, 9)
    const { accepted, rejected } = admitFiles(chips, [{ name: 'a', size: 1 }, { name: 'b', size: 1 }])
    assert.deepEqual(accepted.map((f) => f.name), ['a'])
    assert.match(rejected[0].error, new RegExp(`up to ${MAX_ATTACHMENTS} files.*"b"`))
  })
  it('takes zero-byte files', () => {
    assert.equal(admitFiles([], [{ name: 'empty.txt', size: 0 }]).accepted.length, 1)
  })
  it('builds the upload URL with the name as a query param', () => {
    assert.equal(uploadPath('c 1', 'a b&c.pdf'), '/api/conversations/c%201/uploads?name=a+b%26c.pdf')
  })
})

describe('FE-7 attachments: sending', () => {
  it('canSendWith: text, or at least one uploaded file; never while uploading', () => {
    assert.equal(canSendWith('', []), false)
    assert.equal(canSendWith(' hi ', []), true)
    assert.equal(canSendWith('', [done('a', 'a.pdf')]), true)
    assert.equal(canSendWith('hi', [done('a', 'a.pdf'), newChip('b', { name: 'b', size: 1 })]), false)
    assert.equal(canSendWith('', [rejectedChip('c', { name: 'c', size: 1 }, 'x')]), false)
  })
  it('readyAttachments keeps pick order and skips failed/uploading chips', () => {
    const chips = [done('a', 'a.pdf'), newChip('b', { name: 'b', size: 1 }), done('c', 'c.png', att('c.png', { mime: 'image/png' }))]
    assert.deepEqual(readyAttachments(chips).map((a) => a.name), ['a.pdf', 'c.png'])
  })
  it('markSendFailure marks the chip the 400 names', () => {
    const chips = [done('a', 'a.pdf'), done('b', 'b.pdf')]
    const next = markSendFailure(chips, '"shared/b.pdf" is no longer in the shared files.')
    assert.equal(next[0].status, 'done')
    assert.equal(next[1].status, 'error')
    assert.match(next[1].error, /"b\.pdf" is no longer in the shared files/)
    assert.equal(markSendFailure(chips, 'Something else.'), null)
  })
  it('sendFailureHint names the file instead of the API wording', () => {
    const chips = [done('a', 'a.pdf'), done('b', 'b.pdf')]
    const be = '"shared/b.pdf" wasn\'t uploaded to this conversation. Upload it with PUT /api/conversations/c1/uploads first.'
    assert.equal(sendFailureHint(chips, be), '"b.pdf" is no longer in the shared files. Remove it, or add it again.')
    assert.match(sendFailureHint(chips, '"shared/a.pdf" and "shared/b.pdf" are gone'), /^2 files are no longer/)
    assert.equal(sendFailureHint(chips, 'A message can carry at most 10 attachments.'), 'A message can carry at most 10 attachments.')
  })
})

describe('FE-7 attachments: text', () => {
  it('uploadFailureText covers network, 413, the server 400 and the fallback', () => {
    assert.match(uploadFailureText(0, null, 'a.pdf'), /"a\.pdf" didn't upload\. Check your connection/)
    assert.match(uploadFailureText(413, null, 'a.pdf'), /25 MB/)
    assert.equal(uploadFailureText(400, '"name" must be a file name, not a path.', 'a\\b'), '"a\\b" can\'t be uploaded: "name" must be a file name, not a path.')
    assert.equal(uploadFailureText(500, 'Disk full.', 'a'), 'Disk full.')
    assert.equal(uploadFailureText(500, null, 'a'), '"a" didn\'t upload (error 500).')
  })
  it('chipLine: progress, size, rename after a collision, error', () => {
    const up = { ...newChip('a', { name: 'a.pdf', size: 10 }), progress: 0.42 }
    assert.equal(chipLine(up), 'Uploading 42%')
    assert.equal(chipLine({ ...up, progress: 7 }), 'Uploading 100%')
    assert.match(chipLine(done('a', 'plan.pdf')), /^412(\.\d)? KB$/)
    assert.match(chipLine(done('a', 'plan.pdf', att('plan (2).pdf'))), /^Saved as plan \(2\)\.pdf · 412/)
    assert.equal(chipLine(rejectedChip('x', { name: 'x', size: 1 }, 'Too big.')), 'Too big.')
  })
  it('card kinds, badge and meta', () => {
    assert.equal(isImageAttachment({ name: 'shot.PNG', mime: '' }), true)
    assert.equal(isImageAttachment({ name: 'x', mime: 'image/jpeg' }), true)
    assert.equal(isImageAttachment({ name: 'plan.pdf', mime: 'application/pdf' }), false)
    assert.equal(isPdfAttachment({ name: 'PLAN.PDF', mime: '' }), true)
    assert.equal(fileBadge({ name: 'plan.pdf', mime: '' }), 'PDF')
    assert.equal(fileBadge({ name: 'data.csv', mime: 'text/csv' }), 'CSV')
    assert.equal(fileBadge({ name: 'README', mime: '' }), 'FILE')
    const meta = attachmentMeta({ size: 421888 })
    assert.match(meta.size, /^412/)
    assert.equal(meta.saved, 'saved to shared/')
  })
  it('links point at the DM bot or the group folder', () => {
    assert.equal(attachmentOwner({ root: 'agent' }, { agentId: 'bot1' }), 'bot1')
    assert.deepEqual(attachmentOwner({ root: 'group' }, { groupId: 'g1' }), { groupId: 'g1' })
    assert.equal(attachmentOwner({ root: 'group' }, { agentId: 'bot1' }), null)
    assert.equal(attachmentHref(att('a b.pdf'), { agentId: 'bot1' }), '/api/agents/bot1/files/content?path=shared%2Fa+b.pdf')
    assert.match(attachmentHref({ root: 'group', path: 'shared/x.png' }, { groupId: 'g1' }), /g1/)
    assert.equal(attachmentHref(att('a'), {}), null)
  })
  it('sidebar preview for a files-only message', () => {
    assert.equal(attachmentsPreview(undefined), null)
    assert.equal(attachmentsPreview([]), null)
    assert.equal(attachmentsPreview([{ name: 'plan.pdf' }]), '📎 plan.pdf')
    assert.equal(attachmentsPreview([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), '📎 3 files')
    assert.match(previewText({ role: 'user', content: '', attachments: [{ name: 'plan.pdf' }] }), /📎 plan\.pdf/)
    assert.match(previewText({ role: 'user', content: 'see this', attachments: [{ name: 'plan.pdf' }] }), /see this/)
    assert.doesNotMatch(previewText({ role: 'user', content: 'hi' }), /📎/)
  })
  it('shared-here and the group row label (GAP-A10)', () => {
    assert.equal(sharedHere({ sharedInConversationId: 'g1' }, 'g1'), true)
    assert.equal(sharedHere({ sharedInConversationId: 'g1' }, 'g2'), false)
    assert.equal(sharedHere({}, undefined), false)
    const when = (who) => `${who || '—'} · 8:22 PM`
    assert.equal(groupSharedWhen({ sharedInConversationId: 'g1' }, 'g1', 'You', when), 'You · sent in this chat · 8:22 PM')
    assert.equal(groupSharedWhen({}, 'g1', 'You', when), 'You · 8:22 PM')
  })
  it('dragHasFiles only for file drags', () => {
    assert.equal(dragHasFiles(['Files']), true)
    assert.equal(dragHasFiles(['text/plain', 'text/uri-list']), false)
    assert.equal(dragHasFiles(null), false)
  })
})
