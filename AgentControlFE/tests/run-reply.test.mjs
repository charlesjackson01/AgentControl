import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { disableThinkingPatch, isEmptyReply, runReplyView, taskResultView, EMPTY_REPLY_ERROR } from '../src/lib/run-reply.ts'

describe('runReplyView', () => {
  it('shows the run error', () => {
    const msg = 'The model used its whole reply budget thinking and returned no text…'
    assert.deepEqual(runReplyView({ status: 'failed', output: '', error: msg }), { kind: 'error', text: msg })
  })
  it('never renders an empty bubble or (no text)', () => {
    assert.deepEqual(runReplyView({ status: 'succeeded', output: '' }), { kind: 'error', text: EMPTY_REPLY_ERROR })
    assert.deepEqual(runReplyView({ status: 'succeeded', output: ' (no text) ' }), { kind: 'error', text: EMPTY_REPLY_ERROR })
    assert.equal(runReplyView({ status: 'failed', output: '', error: null }).kind, 'error')
    assert.match(runReplyView({ status: 'failed', output: '' }).text, /failed/)
  })
  it('passes real output through', () => {
    assert.deepEqual(runReplyView({ status: 'succeeded', output: 'hi' }), { kind: 'assistant', text: 'hi' })
  })
})

describe('taskResultView', () => {
  it('keeps Could not finish failures and real results', () => {
    assert.deepEqual(taskResultView('Could not finish: x', true), { failed: true, text: 'Could not finish: x' })
    assert.deepEqual(taskResultView('done!', false), { failed: false, text: 'done!' })
  })
  it('treats placeholder results as failed', () => {
    assert.equal(taskResultView('(no text)', false).failed, true)
    assert.equal(isEmptyReply('  '), true)
  })
})

describe('disableThinkingPatch', () => {
  it('create: only sends true', () => {
    assert.deepEqual(disableThinkingPatch(false, undefined, false), {})
    assert.deepEqual(disableThinkingPatch(true, undefined, false), { disableThinking: true })
  })
  it('edit: omit unchanged, false clears, true sets', () => {
    assert.deepEqual(disableThinkingPatch(true, true, true), {})
    assert.deepEqual(disableThinkingPatch(false, undefined, true), {})
    assert.deepEqual(disableThinkingPatch(false, true, true), { disableThinking: false })
    assert.deepEqual(disableThinkingPatch(true, undefined, true), { disableThinking: true })
  })
})
