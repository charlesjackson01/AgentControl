import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { COMMANDS, chatPanelPath, commandAction, findCommand, matchCommands, messagePath, parseSlash, slashPrefix } from '../src/lib/commands.ts'

describe('slash commands: catalogue', () => {
  it('lists the seven commands in ticket order (FE-P2-5: /sandbox is now /vm)', () => {
    assert.deepEqual(COMMANDS.map((c) => c.name), ['new', 'group', 'files', 'skills', 'memory', 'settings', 'vm'])
  })
  it('FE-P2-5: every command runs in a DM', () => {
    const dm = { conversationId: 'c1', isGroup: false }
    const live = COMMANDS.filter((c) => c.unavailable(dm) === null).map((c) => c.name)
    assert.deepEqual(live, ['new', 'group', 'files', 'skills', 'memory', 'settings', 'vm'])
    assert.equal(findCommand('group').unavailable({}), null)
  })
  it('FE-P2-5: /sandbox is an alias of /vm; groups have no VM', () => {
    assert.equal(findCommand('sandbox').name, 'vm')
    assert.equal(parseSlash('/sandbox').command.name, 'vm')
    assert.match(findCommand('vm').unavailable({}), /Open a chat/)
    assert.equal(findCommand('vm').unavailable({ conversationId: 'g', isGroup: true }), "Groups don't have a VM. Each bot keeps its own; open its chat.")
  })
  it('panel commands need an open chat; in a group only /skills is off (FE-6)', () => {
    const g = { conversationId: 'g', isGroup: true }
    for (const name of ['settings', 'files', 'skills', 'memory']) assert.match(findCommand(name).unavailable({}), /Open a chat/)
    for (const name of ['settings', 'files', 'memory']) assert.equal(findCommand(name).unavailable(g), null)
    assert.match(findCommand('skills').unavailable(g), /Groups don't have skills/)
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
    assert.deepEqual(matchCommands('s').map((c) => c.name), ['skills', 'settings', 'vm', 'files'], 'vm by its sandbox alias')
    assert.deepEqual(matchCommands('v').map((c) => c.name), ['vm'])
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
      files: 'files', skills: 'skills', memory: 'memory', vm: 'vm',
    })
  })
  it('/skills and /memory open their settings tab', () => {
    assert.deepEqual(commandAction('skills', dm), { kind: 'navigate', to: '/c/c%201?panel=settings&tab=skills' })
    assert.deepEqual(commandAction('memory', dm), { kind: 'navigate', to: '/c/c%201?panel=settings&tab=memory' })
  })
  it('FE-4: /files opens the bot folder at shared/ (?panel=files&path=shared)', () => {
    assert.deepEqual(commandAction('files', dm), { kind: 'navigate', to: '/c/c%201?panel=files&path=shared' })
  })
  it('FE-P2-5: /vm and /sandbox open the VM tab', () => {
    assert.deepEqual(commandAction('vm', dm), { kind: 'navigate', to: '/c/c%201?panel=settings&tab=vm' })
    assert.deepEqual(commandAction('sandbox', dm), { kind: 'navigate', to: '/c/c%201?panel=settings&tab=vm' })
  })
  it('unbacked commands return their reason instead of faking it', () => {
    assert.equal(commandAction('vm', { conversationId: 'g', isGroup: true }).kind, 'unavailable')
    assert.equal(commandAction('skills', { conversationId: 'g', isGroup: true }).kind, 'unavailable')
  })
  it('deep links', () => {
    assert.equal(chatPanelPath('c1', 'files', { path: 'shared/a b.png' }), '/c/c1?panel=files&path=shared%2Fa+b.png')
    assert.equal(chatPanelPath('c1', 'settings'), '/c/c1?panel=settings')
    assert.equal(chatPanelPath('c1', 'settings', { tab: 'memory' }), '/c/c1?panel=settings&tab=memory')
    assert.equal(chatPanelPath('c1', 'settings', { path: 'x' }), '/c/c1?panel=settings', 'path only belongs to panel=files')
    assert.equal(messagePath('c1', 'msg-1'), '/c/c1?m=msg-1')
  })
})

describe('slash commands: groups (FE-6)', () => {
  const g = { conversationId: 'g1', isGroup: true }
  it('/group opens the New group dialog from anywhere', () => {
    assert.deepEqual(commandAction('group', {}), { kind: 'new-group' })
    assert.deepEqual(commandAction('group', g), { kind: 'new-group' })
  })
  it('in a group, /files opens Shared files, /memory and /settings their group tabs', () => {
    assert.deepEqual(commandAction('files', g), { kind: 'navigate', to: '/c/g1?panel=files&path=shared' })
    assert.deepEqual(commandAction('memory', g), { kind: 'navigate', to: '/c/g1?panel=settings&tab=memory' })
    assert.deepEqual(commandAction('settings', g), { kind: 'navigate', to: '/c/g1?panel=settings&tab=settings' })
  })
})
