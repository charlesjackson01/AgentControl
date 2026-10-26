import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { errorMessageFrom } from '../src/lib/api-error.ts'
import {
  BLANK_AVATAR_CHOICES, DRAFT_NETWORK_ERROR, LONG_WAIT_MS, MAX_DRAFT_PROMPT_CHARS,
  blankCard, canCreate, canRetry, cardFromDraft, composerLocked, createBody, createFailureText,
  draftFailureText, draftRequestBody, draftingStatus, elapsedLabel, folderLabel, isAbort, modelOptions,
  nameError, newBotApi, newBotNavState, newCommandPrompt, normalizeDefaults, normalizeDraft, phaseAfterDraft,
  pickerChoices, placeholderFor, previousOf, profilePrefill, readNewBotNav, startingSkillsTotal, tooLongNotice,
} from '../src/lib/new-bot.ts'

/* A request() like lib/api.ts, over a mocked fetch: records calls, throws {message,status} like ApiError. */
function mockApi(routes) {
  const calls = []
  const fetch = async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal })
    const key = `${init.method ?? 'GET'} ${path.split('?')[0]}`
    const route = routes[key]
    if (!route) throw new Error(`unmocked ${key}`)
    return route(init, path)
  }
  const request = async (path, init) => {
    const res = await fetch(path, init)
    if (res.status >= 400) {
      let message = 'Request failed'
      try { message = errorMessageFrom(JSON.parse(res.text)) } catch { /* non-JSON */ }
      const err = new Error(message)
      err.status = res.status
      throw err
    }
    return JSON.parse(res.text)
  }
  return { calls, api: newBotApi(request) }
}
const json = (status, body) => ({ status, text: JSON.stringify(body) })

const DEFAULTS = {
  skills: [
    { sourceId: 'core', label: 'AgentControl core', count: 2, skillIds: ['core/a', 'core/b'] },
    { sourceId: 'superpowers', label: 'superpowers', count: 1, skillIds: ['sp/x'] },
    { sourceId: 'ecc', label: 'ECC essentials', count: 2, skillIds: ['ecc/1', 'ecc/2'] },
  ],
  internetPolicy: 'ask',
  endpointId: 'ep_1',
  modelId: 'mock-model',
}
const DRAFT = {
  name: 'Trip Planner', role: 'Travel organizer', description: 'Keeps itineraries in its folder.',
  avatarEmoji: '🧳', avatarChoices: ['🧳', '✈️', '🗺', '🏨'],
  rules: ['Always confirm dates in my time zone (Central).', 'Never book or pay for anything. Draft it and ask me.'],
}
const FALLBACK = (warningCode, warning) => ({ name: '', role: '', description: '', avatarEmoji: '', avatarChoices: [], rules: [], warning, warningCode })

describe('composer: /new and the raw prompt (S6, S7)', () => {
  it('takes the raw text after "/new " without trimming', () => {
    assert.equal(newCommandPrompt('/new a bot  '), 'a bot  ')
    assert.equal(newCommandPrompt('/new   spaced'), '  spaced')
    assert.equal(newCommandPrompt('/NEW x'), 'x')
    assert.equal(newCommandPrompt('/new\nmulti\nline'), 'multi\nline')
  })
  it('S6: /new alone is an empty prompt; other text is not /new', () => {
    assert.equal(newCommandPrompt('/new'), '')
    assert.equal(newCommandPrompt('/new '), '')
    assert.equal(newCommandPrompt('/newbot x'), null)
    assert.equal(newCommandPrompt('hello /new'), null)
  })
  it('S7: counts the raw length (whitespace included) against 2,000', () => {
    assert.equal(tooLongNotice('x'.repeat(MAX_DRAFT_PROMPT_CHARS)), null)
    assert.equal(tooLongNotice(' '.repeat(1999) + 'xy'), 'Describe the bot in 2,000 characters or fewer (2,001 now).')
    const s7 = newCommandPrompt('/new ' + 'a bot that tracks every flight, hotel, train and dinner reservation for the next twelve months and '.repeat(22))
    assert.equal(tooLongNotice(s7), `Describe the bot in 2,000 characters or fewer (${s7.length.toLocaleString('en-US')} now).`)
  })
  it('placeholders and locking per phase', () => {
    assert.equal(placeholderFor(null, 'Primary'), 'Message Primary…')
    assert.equal(placeholderFor({ kind: 'ask' }, 'Primary'), 'Describe the new bot…')
    assert.equal(placeholderFor({ kind: 'drafting', startedAt: 0 }, 'Primary'), 'Primary is writing the draft…')
    assert.equal(placeholderFor({ kind: 'cancelled' }, 'Primary'), 'Message Primary…')
    assert.equal(placeholderFor({ kind: 'failed', message: 'x' }, 'Primary'), 'Message Primary…')
    assert.equal(placeholderFor({ kind: 'card' }, 'Primary'), 'Reply to change the draft, e.g. "call it Wanderer"…')
    assert.equal(composerLocked({ kind: 'drafting', startedAt: 0 }), true)
    assert.equal(composerLocked({ kind: 'card', creating: true }), true)
    assert.equal(composerLocked({ kind: 'card' }), false)
    assert.equal(composerLocked({ kind: 'failed', message: '' }), false)
  })
})

describe('S1 / S2: drafting status', () => {
  it('S1 under 30 s, S2 after, elapsed as m:ss, never a timeout length', () => {
    assert.deepEqual(draftingStatus(12_000), { title: 'Writing a draft…', sub: '0:12 · usually about 10 seconds, slow models can take a few minutes', long: false })
    const s2 = draftingStatus(161_000)
    assert.deepEqual(s2, { title: 'Still writing the draft…', sub: '2:41 · the model is slow right now. You can keep waiting, cancel, or fill it in yourself.', long: true })
    assert.equal(draftingStatus(LONG_WAIT_MS - 1).long, false)
    assert.equal(draftingStatus(LONG_WAIT_MS).long, true)
    assert.doesNotMatch(s2.sub + draftingStatus(0).sub, /timeout|time out|minutes? left|\b\d+ ?s\b/i)
    assert.equal(elapsedLabel(0), '0:00')
    assert.equal(elapsedLabel(605_400), '10:05')
  })
})

describe('draft request', () => {
  it('POSTs {prompt} raw, with the abort signal', async () => {
    const { calls, api } = mockApi({ 'POST /api/agents/draft': () => json(200, DRAFT) })
    const ctrl = new AbortController()
    const d = await api.draft(draftRequestBody('  a travel bot '), ctrl.signal)
    assert.equal(calls[0].path, '/api/agents/draft')
    assert.deepEqual(calls[0].body, { prompt: '  a travel bot ' })
    assert.equal(calls[0].signal, ctrl.signal)
    assert.equal(d.name, 'Trip Planner')
    assert.equal(d.warning, undefined)
  })
  it('a reply re-drafts with {prompt: reply, previous: the card as shown}', async () => {
    const { calls, api } = mockApi({ 'POST /api/agents/draft': () => json(200, { ...DRAFT, name: 'Wanderer' }) })
    const card = cardFromDraft(null, normalizeDraft(DRAFT), normalizeDefaults(DEFAULTS))
    card.role = 'Edited by hand'
    card.rules = [...card.rules, '   ']
    await api.draft(draftRequestBody('call it Wanderer', previousOf(card)))
    assert.deepEqual(calls[0].body, {
      prompt: 'call it Wanderer',
      previous: { name: 'Trip Planner', role: 'Edited by hand', description: DRAFT.description, avatarEmoji: '🧳', avatarChoices: DRAFT.avatarChoices, rules: DRAFT.rules },
    })
  })
  it('previous stays inside the BE limits and leaves a blank avatar out', () => {
    const card = { ...blankCard(null), name: 'n'.repeat(70), role: 'r'.repeat(90), description: 'd'.repeat(310), rules: Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(600, 'x')) }
    const p = previousOf(card)
    assert.equal(p.name.length, 60)
    assert.equal(p.role.length, 80)
    assert.equal(p.description.length, 300)
    assert.equal(p.rules.length, 20)
    assert.ok(p.rules.every((r) => r.length <= 500))
    assert.equal('avatarEmoji' in p, false)
    assert.equal('avatarChoices' in p, false)
  })
  it('a reply keeps model, internet and chips; the draft replaces the rest', () => {
    const defaults = normalizeDefaults(DEFAULTS)
    const card = { ...cardFromDraft(null, normalizeDraft(DRAFT), defaults), internetPolicy: 'never', sourcesOn: ['core'], endpointId: 'ep_2', modelId: 'm2' }
    const next = cardFromDraft(card, normalizeDraft({ ...DRAFT, name: 'Wanderer' }), defaults)
    assert.equal(next.name, 'Wanderer')
    assert.equal(next.internetPolicy, 'never')
    assert.deepEqual(next.sourcesOn, ['core'])
    assert.equal(next.endpointId, 'ep_2')
  })
})

describe('S3 / S4 / S5: cancel, fallback warning, errors', () => {
  it('S3: an aborted fetch is an AbortError; a 200 "cancelled" is S3 too', async () => {
    const { api } = mockApi({
      'POST /api/agents/draft': (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
    })
    const ctrl = new AbortController()
    const p = api.draft({ prompt: 'x' }, ctrl.signal)
    ctrl.abort()
    await assert.rejects(p, (err) => isAbort(err))
    assert.deepEqual(phaseAfterDraft(normalizeDraft(FALLBACK('cancelled', 'The draft was cancelled.'))), { kind: 'cancelled' })
  })
  for (const [code, warning] of [
    ['no_primary', 'No Primary bot with an endpoint to write the draft. Fill it in by hand.'],
    ['upstream', "Primary couldn't write a draft right now. Fill it in by hand."],
    ['invalid_output', "Primary's draft wasn't usable. Fill it in by hand."],
  ]) {
    it(`S4: 200 with warningCode ${code} → a blank card plus the warning`, async () => {
      const { api } = mockApi({ 'POST /api/agents/draft': () => json(200, FALLBACK(code, warning)) })
      const d = await api.draft({ prompt: 'x' })
      assert.equal(d.warningCode, code)
      assert.deepEqual(phaseAfterDraft(d), { kind: 'card', warning })
      const defaults = normalizeDefaults(DEFAULTS)
      const card = cardFromDraft(null, d, defaults)
      assert.deepEqual({ ...card }, blankCard(defaults))
      assert.deepEqual(pickerChoices(card), BLANK_AVATAR_CHOICES)
      assert.equal(canCreate(card), false)
    })
  }
  it('S4 over an edited card: blank fields, the card keeps model/internet/chips', () => {
    const defaults = normalizeDefaults(DEFAULTS)
    const card = { ...cardFromDraft(null, normalizeDraft(DRAFT), defaults), internetPolicy: 'always' }
    const next = cardFromDraft(card, normalizeDraft(FALLBACK('upstream', 'w')), defaults)
    assert.equal(next.name, '')
    assert.equal(next.internetPolicy, 'always')
  })
  it('no Retry for no_primary', () => {
    assert.equal(canRetry('no_primary'), false)
    assert.equal(canRetry('upstream'), true)
    assert.equal(canRetry(undefined), true)
  })
  it('S5: fetch rejected, non-JSON and 5xx → the network copy; a 4xx → the server message', async () => {
    assert.equal(draftFailureText(new TypeError('Failed to fetch')), DRAFT_NETWORK_ERROR)
    const { api } = mockApi({
      'POST /api/agents/draft': (init) => {
        const prompt = JSON.parse(init.body).prompt
        if (prompt === '502') return { status: 502, text: '<html>Bad gateway</html>' }
        if (prompt === '500') return json(500, { statusCode: 500, error: 'Internal Server Error', message: 'boom' })
        return json(400, { statusCode: 400, error: 'Bad Request', message: '"prompt" must be 2000 characters or fewer.' })
      },
    })
    for (const p of ['502', '500']) {
      const err = await api.draft({ prompt: p }).catch((e) => e)
      assert.equal(draftFailureText(err), DRAFT_NETWORK_ERROR)
    }
    const err = await api.draft({ prompt: '400' }).catch((e) => e)
    assert.equal(draftFailureText(err), '"prompt" must be 2000 characters or fewer.')
    assert.equal(DRAFT_NETWORK_ERROR, "Couldn't reach AgentControl to write the draft. Check that the server is running, then try again.")
  })
})

describe('tolerant parsing', () => {
  it('defaults: a missing label falls back to sourceId; count from skillIds', () => {
    const d = normalizeDefaults({ skills: [{ sourceId: 'custom', skillIds: ['c/1'] }, { label: 'no id' }, null], endpointId: 'ep', modelId: 'm' })
    assert.deepEqual(d.skills, [{ sourceId: 'custom', label: 'custom', count: 1, skillIds: ['c/1'] }])
    assert.equal(d.internetPolicy, 'ask')
    assert.equal(startingSkillsTotal(normalizeDefaults(DEFAULTS)), 5)
    assert.deepEqual(normalizeDefaults(null), { skills: [], internetPolicy: 'ask', endpointId: '', modelId: '' })
  })
  it('draft: missing avatarChoices falls back to [avatarEmoji]; junk fields are dropped', () => {
    const d = normalizeDraft({ name: 'A', avatarEmoji: '🧳', rules: ['x', 3] })
    assert.deepEqual(d.avatarChoices, ['🧳'])
    assert.deepEqual(d.rules, ['x'])
    assert.equal(d.role, '')
    assert.deepEqual(pickerChoices(d), [])
    assert.deepEqual(pickerChoices(normalizeDraft(DRAFT)), ['✈️', '🗺', '🏨'])
    assert.equal(normalizeDraft({ warningCode: 'nope', warning: '' }).warningCode, undefined)
  })
})

describe('card fields', () => {
  it('model options: one per endpoint, the defaults model on Primary\'s endpoint', () => {
    const opts = modelOptions([{ id: 'ep_1', name: 'Mock', defaultModel: 'other' }, { id: 'ep_2', name: 'OpenRouter', defaultModel: 'gpt' }], normalizeDefaults(DEFAULTS))
    assert.deepEqual(opts, [
      { endpointId: 'ep_1', modelId: 'mock-model', label: 'Mock · mock-model' },
      { endpointId: 'ep_2', modelId: 'gpt', label: 'OpenRouter · gpt' },
    ])
  })
  it('validation: Create needs a name; the message shows once touched', () => {
    const card = blankCard(null)
    assert.equal(canCreate(card), false)
    assert.equal(nameError(card, false), null)
    assert.equal(nameError(card, true), 'Give the bot a name.')
    assert.equal(nameError({ ...card, name: '   ' }, true), 'Give the bot a name.')
    assert.equal(canCreate({ ...card, name: 'A' }), true)
  })
  it('slug preview: debounced in the hook; never called for a blank name; returns the BE slug', async () => {
    const { calls, api } = mockApi({ 'GET /api/agents/slug-preview': (_, path) => json(200, { slug: new URL(path, 'http://x').searchParams.get('name') === 'Trip Planner' ? 'trip-planner' : 'x' }) })
    assert.equal(await api.slugPreview('   '), null)
    assert.equal(await api.slugPreview(''), null)
    assert.equal(calls.length, 0)
    assert.equal(await api.slugPreview('Trip Planner'), 'trip-planner')
    assert.equal(calls[0].path, '/api/agents/slug-preview?name=Trip%20Planner')
    assert.equal(folderLabel('trip-planner'), 'bots/trip-planner/')
    assert.equal(folderLabel(null), '')
  })
})

describe('create (S8 / S9)', () => {
  const defaults = normalizeDefaults(DEFAULTS)
  it('POST /api/agents body: trimmed fields, internetPolicy, emoji avatar, no instructions/temperature, skillIds left out when every chip is on', async () => {
    const { calls, api } = mockApi({ 'POST /api/agents': () => json(201, { id: 'ag_1', name: 'Trip Planner' }) })
    const card = { ...cardFromDraft(null, normalizeDraft(DRAFT), defaults), name: ' Trip Planner ', internetPolicy: 'always', rules: [...DRAFT.rules, '  '] }
    const saved = await api.create(createBody(card, defaults))
    assert.equal(saved.id, 'ag_1')
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, {
      name: 'Trip Planner', role: 'Travel organizer', description: DRAFT.description, endpointId: 'ep_1', modelId: 'mock-model',
      rules: DRAFT.rules, internetPolicy: 'always', avatar: { kind: 'emoji', value: '🧳' },
    })
    for (const k of ['instructions', 'temperature', 'skillIds']) assert.equal(k in calls[0].body, false)
  })
  it('a chip turned off sends the union of the on sources\' skillIds', () => {
    const card = { ...blankCard(defaults), name: 'A', sourcesOn: ['core', 'ecc'] }
    assert.deepEqual(createBody(card, defaults).skillIds, ['core/a', 'core/b', 'ecc/1', 'ecc/2'])
    assert.deepEqual(createBody({ ...card, sourcesOn: [] }, defaults).skillIds, [])
  })
  it('a blank avatar is left out; internetPolicy defaults to ask', () => {
    const body = createBody({ ...blankCard(defaults), name: 'A' }, defaults)
    assert.equal('avatar' in body, false)
    assert.equal(body.internetPolicy, 'ask')
  })
  it('S9: the server message, inline', async () => {
    const { api } = mockApi({ 'POST /api/agents': () => json(400, { statusCode: 400, error: 'Bad Request', message: 'The setting could not be saved. Please retry.' }) })
    const err = await api.create(createBody({ ...blankCard(defaults), name: 'Trip Planner' }, defaults)).catch((e) => e)
    assert.equal(createFailureText('Trip Planner', err), 'Couldn\u2019t create Trip Planner: the setting could not be saved. Please retry.')
    assert.equal(createFailureText('X', new TypeError('Failed to fetch')), 'Couldn\u2019t create X: could not reach AgentControl. Check that the server is running.')
  })
})

describe('routing and Open full settings', () => {
  it('router state round-trips with a fresh nonce each time', () => {
    const a = newBotNavState('x')
    const b = newBotNavState('x')
    assert.notEqual(a.nonce, b.nonce)
    assert.deepEqual(readNewBotNav({ newBot: a }), a)
    assert.equal(readNewBotNav(null), null)
    assert.equal(readNewBotNav({ newBot: { prompt: 1 } }), null)
  })
  it('profile prefill carries the card (skillIds only when a chip changed)', () => {
    const defaults = normalizeDefaults(DEFAULTS)
    const card = cardFromDraft(null, normalizeDraft(DRAFT), defaults)
    const p = profilePrefill(card, defaults)
    assert.equal(p.name, 'Trip Planner')
    assert.equal(p.avatarEmoji, '🧳')
    assert.equal('skillIds' in p, false)
    assert.deepEqual(profilePrefill({ ...card, sourcesOn: ['superpowers'] }, defaults).skillIds, ['sp/x'])
  })
})
