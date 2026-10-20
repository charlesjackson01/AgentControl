import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { COMMANDS, chatPanelPath, commandAction, findCommand, matchCommands, messagePath, parseSlash, slashPrefix } from '../src/lib/commands.ts'

describe('slash commands: catalogue', () => {
  it('lists the seven FE-2 commands in ticket order', () => {
    assert.deepEqual(COMMANDS.map((c) => c.name), ['new', 'group', 'files', 'skills', 'memory', 'settings', 'sandbox'])
  })
  it('FE-3: /new, /skills, /memory and /settings run in a DM; the rest say which ticket brings them', () => {
    const dm = { conversationId: 'c1', isGroup: false }
    const live = COMMANDS.filter((c) => c.unavailable(dm) === null).map((c) => c.name)
    assert.deepEqual(live, ['new', 'skills', 'memory', 'settings'])
    assert.match(findCommand('group').unavailable(dm), /BE-5|FE-6/)
    assert.match(findCommand('files').unavailable(dm), /FE-4/)
    assert.match(findCommand('sandbox').unavailable(dm), /FE-4/)
  })
  it('settings-tab commands need an open DM', () => {
    for (const name of ['settings', 'skills', 'memory']) {
      assert.match(findCommand(name).unavailable({}), /Open a chat/)
      assert.match(findCommand(name).unavailable({ conversationId: 'g', isGroup: true }), /FE-6/)
    }
  })
})

describe('slash commands: typing', () => {
  it('slashPrefix only while typing the name', () => {
    assert.equal(slashPrefix('/'), '')
    assert.equal(slashPrefix('/Me'), 'me')
    assert.equal(slashPrefix('/new x'), null)
    assert.equal(slashPrefix('hello /new'), null)
    assert.equal(slashPrefix(''), null)
  })
  it('matchCommands: all for empty, name prefix first, then contains/label', () => {
    assert.equal(matchCommands('').length, 7)
    assert.deepEqual(matchCommands('s').map((c) => c.name), ['skills', 'settings', 'sandbox', 'files'])
    assert.deepEqual(matchCommands('/se').map((c) => c.name), ['settings'])
    assert.deepEqual(matchCommands('bot').map((c) => c.name), ['new'])
    assert.deepEqual(matchCommands('zzz'), [])
  })
  it('parseSlash: known commands with args; anything else is plain text', () => {
    assert.equal(parseSlash('/new').command.name, 'new')
    assert.deepEqual({ ...parseSlash('  /NEW a research bot \n'), command: undefined }, { command: undefined, args: 'a research bot' })
    assert.equal(parseSlash('/etc/hosts is odd'), null)
    assert.equal(parseSlash('/unknown thing'), null)
    assert.equal(parseSlash('not /new'), null)
  })
})

describe('slash commands: dispatch', () => {
  const dm = { conversationId: 'c 1', isGroup: false }
  it('/new opens the new-bot flow and carries its text', () => {
    assert.deepEqual(commandAction('new', dm, 'a bot'), { kind: 'new-bot', args: 'a bot' })
    assert.deepEqual(commandAction('new', {}), { kind: 'new-bot', args: '' })
  })
  it('/settings navigates to the chat with its panel open', () => {
    assert.deepEqual(commandAction('settings', dm), { kind: 'navigate', to: '/c/c%201?panel=settings' })
  })
  it('tab commands know their FE-3/FE-4 settings tab for when they go live', () => {
    assert.deepEqual(Object.fromEntries(COMMANDS.filter((c) => c.tab).map((c) => [c.name, c.tab])), {
      files: 'files', skills: 'skills', memory: 'memory', sandbox: 'sandbox',
    })
  })
  it('/skills and /memory open their settings tab', () => {
    assert.deepEqual(commandAction('skills', dm), { kind: 'navigate', to: '/c/c%201?panel=settings&tab=skills' })
    assert.deepEqual(commandAction('memory', dm), { kind: 'navigate', to: '/c/c%201?panel=settings&tab=memory' })
  })
  it('unbacked commands return their reason instead of faking it', () => {
    for (const name of ['group', 'files', 'sandbox']) assert.equal(commandAction(name, dm).kind, 'unavailable')
    assert.equal(commandAction('settings', { conversationId: 'g', isGroup: true }).kind, 'unavailable')
  })
  it('deep links', () => {
    assert.equal(chatPanelPath('c1', 'files', { path: 'shared/a b.png' }), '/c/c1?panel=files&path=shared%2Fa+b.png')
    assert.equal(chatPanelPath('c1', 'settings'), '/c/c1?panel=settings')
    assert.equal(chatPanelPath('c1', 'settings', { tab: 'memory' }), '/c/c1?panel=settings&tab=memory')
    assert.equal(chatPanelPath('c1', 'settings', { path: 'x' }), '/c/c1?panel=settings', 'path only belongs to panel=files')
    assert.equal(messagePath('c1', 'msg-1'), '/c/c1?m=msg-1')
  })
})
