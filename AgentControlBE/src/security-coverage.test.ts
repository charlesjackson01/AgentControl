/**
 * BE-P2-19: every §13 row is covered, and every reference points at a real test of the right kind.
 * Plain test (reads the test sources only; no engine).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SECURITY_GAPS, SECURITY_ROWS } from './security-coverage.js'

const SRC = dirname(fileURLToPath(import.meta.url))
/** The §13 rows, in plan order. */
const PLAN_ROWS = ['bot_bot', 'host_files', 'memory_profile', 'network', 'resources', 'privilege', 'engine_storage', 'secrets', 'permissions', 'windows_volume']
/** Rows still being filled on this branch (BE-P2-19); must end empty. */
const NOT_YET: string[] = []
const source = (file: string) => readFileSync(join(SRC, file), 'utf8')
const titles = (text: string): string[] => [...text.matchAll(/\b(?:it|describe)(?:\.each\([^\n]*?\))?(?:\.skipIf\([^\n]*?\))?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!.replace(/\\(['"`\\])/g, '$1'))

describe('BE-P2-19 §13 coverage map', () => {
  it('has exactly the plan\'s rows, in order', () => {
    expect(SECURITY_ROWS.map((r) => r.id)).toEqual(PLAN_ROWS)
  })

  it('every row has a Linux test (unit or @vm) and a real-engine test where the plan asks for one', () => {
    for (const r of SECURITY_ROWS.filter((x) => !NOT_YET.includes(x.id))) {
      expect(r.tests.some((t) => t.tag === 'unit' || t.tag === '@vm'), r.id).toBe(true)
    }
    // Plan §6.4: every row but permissions (unit) has an @vm test on Linux; the Windows volume is unit (fake) on Linux.
    const noVm = SECURITY_ROWS.filter((x) => x.id !== 'permissions' && x.id !== 'windows_volume' && !x.tests.some((t) => t.tag === '@vm')).map((x) => x.id)
    expect(noVm).toEqual(NOT_YET)
  })

  it('every reference is a real test in a file of its kind', () => {
    for (const r of SECURITY_ROWS) {
      for (const t of r.tests) {
        const where = `${r.id}: ${t.file} "${t.title}"`
        expect(existsSync(join(SRC, t.file)), where).toBe(true)
        if (t.tag === '@vm') expect(t.file, where).toMatch(/\.vm\.test\.ts$/)
        if (t.tag === 'unit') expect(t.file, where).toMatch(/^(?!.*\.(vm|win|mac)\.test\.ts$).*\.test\.ts$/)
        if (t.tag === '@win') expect(t.file, where).toMatch(/\.win\.test\.ts$/)
        if (t.tag === '@mac') expect(t.file, where).toMatch(/\.mac\.test\.ts$/)
        expect(titles(source(t.file)).some((x) => x.includes(t.title)), where).toBe(true)
      }
    }
  })

  it('@vm, @win and @mac files gate themselves (skipped without their opt-in)', () => {
    const files = new Set(SECURITY_ROWS.flatMap((r) => r.tests.filter((t) => t.tag !== 'unit').map((t) => t.file)))
    for (const f of files) {
      const text = source(f)
      if (f.endsWith('.vm.test.ts')) expect(text, f).toMatch(/AC_VM_TESTS|VM_TESTS/)
      if (f.endsWith('.win.test.ts')) expect(text, f).toMatch(/describe\.skipIf\(!WIN_TESTS\)\('@win/)
      if (f.endsWith('.mac.test.ts')) expect(text, f).toMatch(/describe\.skipIf\(!MAC_TESTS\)\('@mac/)
    }
  })

  it('every gap belongs to a row and is listed in docs/vm.md', () => {
    const doc = readFileSync(join(SRC, '..', '..', 'docs', 'vm.md'), 'utf8')
    for (const g of SECURITY_GAPS) {
      expect(PLAN_ROWS, g.row).toContain(g.row)
      expect(doc, g.gap).toContain(g.gap)
    }
  })
})
