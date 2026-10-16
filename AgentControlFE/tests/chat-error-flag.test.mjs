import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chatMessageView, liveRunOutcome, retryTextBefore, EMPTY_REPLY_ERROR } from '../src/lib/run-reply.ts'

const BUDGET = 'The model used its whole reply budget thinking and returned no text…'
const u = (content) => ({ role: 'user', content })
const a = (content, error) => (error ? { role: 'assistant', content, error: true } : { role: 'assistant', content })

describe('chatMessageView', () => {
  it('renders flagged assistant messages as errors with their content', () => {
    assert.deepEqual(chatMessageView(a(BUDGET, true)), { kind: 'error', text: BUDGET })
  })
  it('flagged but empty still reads as a failure', () => {
    assert.equal(chatMessageView(a('', true)).kind, 'error')
    assert.match(chatMessageView(a('  ', true)).text, /failed/)
  })
  it('normal replies and user messages pass through; empty unflagged replies are errors', () => {
    assert.deepEqual(chatMessageView(a('hi')), { kind: 'assistant', text: 'hi' })
    assert.deepEqual(chatMessageView(u('yo')), { kind: 'user', text: 'yo' })
    assert.deepEqual(chatMessageView(a('(no text)')), { kind: 'error', text: EMPTY_REPLY_ERROR })
  })
  it('a user message never renders as an error even if flagged', () => {
    assert.equal(chatMessageView({ role: 'user', content: 'x', error: true }).kind, 'user')
  })
})

describe('retryTextBefore', () => {
  it('finds the preceding user message', () => {
    const msgs = [u('first'), a('ok'), u('second'), a(BUDGET, true)]
    assert.equal(retryTextBefore(msgs, 3), 'second')
  })
  it('skips assistant messages and returns undefined when none', () => {
    assert.equal(retryTextBefore([a('x'), a(BUDGET, true)], 1), undefined)
    assert.equal(retryTextBefore([u('q'), a('x'), a(BUDGET, true)], 2), 'q')
  })
})

describe('liveRunOutcome', () => {
  it('no duplicate UI when the stored reply carries the flag', () => {
    assert.deepEqual(liveRunOutcome({ status: 'failed', error: BUDGET }, [u('q'), a(BUDGET, true)]), { kind: 'none' })
  })
  it('older backend: unflagged reply plus failed run shows a banner', () => {
    assert.deepEqual(liveRunOutcome({ status: 'failed', error: BUDGET }, [u('q'), a(BUDGET)]), { kind: 'banner', text: BUDGET })
  })
  it('no assistant message: error on the pending turn', () => {
    assert.deepEqual(liveRunOutcome({ status: 'failed', error: BUDGET }, [u('q')]), { kind: 'pending', text: BUDGET })
    assert.deepEqual(liveRunOutcome({ status: 'succeeded' }, [u('q'), a('')]), { kind: 'pending', text: EMPTY_REPLY_ERROR })
  })
  it('success: nothing extra', () => {
    assert.deepEqual(liveRunOutcome({ status: 'succeeded' }, [u('q'), a('hi')]), { kind: 'none' })
  })
})
