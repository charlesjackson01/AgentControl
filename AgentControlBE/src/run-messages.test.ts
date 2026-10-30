import { describe, expect, it } from 'vitest'
import { runMessageContent } from './run-messages.js'

describe('runMessageContent', () => {
  const base = { kind: 'script' as const, name: 'reports', scriptName: 'export_report.py' }
  it('uses the script name and only adds the status when it did not succeed', () => {
    expect(runMessageContent({ ...base, status: 'succeeded' })).toBe('Ran export_report.py')
    expect(runMessageContent({ ...base, status: 'failed' })).toBe('Ran export_report.py (failed)')
    expect(runMessageContent({ ...base, status: 'timed_out' })).toBe('Ran export_report.py (timed out)')
    expect(runMessageContent({ ...base, status: 'stopped' })).toBe('Ran export_report.py (stopped)')
    expect(runMessageContent({ ...base, status: 'denied' })).toBe('Ran export_report.py (denied)')
    expect(runMessageContent({ ...base, status: 'undone' })).toBe('Ran export_report.py (undone)')
  })
  it('describes active runs and falls back to the skill name', () => {
    expect(runMessageContent({ ...base, status: 'queued' })).toBe('Queued export_report.py')
    expect(runMessageContent({ ...base, status: 'running' })).toBe('Running export_report.py')
    expect(runMessageContent({ kind: 'script', name: 'reports', status: 'succeeded' })).toBe('Ran reports')
    expect(runMessageContent({ kind: 'script', name: '', status: 'succeeded' })).toBe('Ran script')
  })
  it('words undo runs', () => {
    expect(runMessageContent({ ...base, kind: 'undo', status: 'succeeded' })).toBe('Undid export_report.py')
    expect(runMessageContent({ ...base, kind: 'undo', status: 'running' })).toBe('Undoing export_report.py')
    expect(runMessageContent({ ...base, kind: 'undo', status: 'failed' })).toBe('Undo of export_report.py (failed)')
  })
})

describe('BE-P2-21: tool build cards', () => {
  const build = { via: 'rebuild' as const, startedBy: 'user' as const, base: 'base' as const, generation: 3, fromGeneration: 2, packages: [] as string[], added: [] as string[] }
  const tb = { kind: 'tool_build' as const, name: 'Rebuild tools', build }
  it('names the bot and the version while building and when built', () => {
    expect(runMessageContent({ ...tb, status: 'queued' }, 'Analyst')).toBe("Building Analyst's tools (version 3)")
    expect(runMessageContent({ ...tb, status: 'running' }, 'Analyst')).toBe("Building Analyst's tools (version 3)")
    expect(runMessageContent({ ...tb, status: 'succeeded' }, 'Analyst')).toBe("Built Analyst's tools (version 3)")
    expect(runMessageContent({ ...tb, status: 'succeeded' })).toBe("Built the bot's tools (version 3)")
  })
  it('a build that did not finish', () => {
    expect(runMessageContent({ ...tb, status: 'stopped' }, 'Analyst')).toBe('Tool build (stopped)')
    expect(runMessageContent({ ...tb, status: 'failed' }, 'Analyst')).toBe('Tool build (failed)')
    expect(runMessageContent({ ...tb, status: 'timed_out' }, 'Analyst')).toBe('Tool build (timed out)')
  })
})
