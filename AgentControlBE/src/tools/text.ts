/** Bounded, offline text operations. All replacements are literal. */
import { argError, readBoolean, readEnum, readString } from './args.js'
import { clipText, fitJson } from './limits.js'
import type { ToolEntry } from './types.js'

const MAX_TEXT = 50_000
const operations = ['trim', 'lowercase', 'uppercase', 'collapse_whitespace', 'sort_lines', 'dedupe_lines', 'replace'] as const
const textExample = { text: '@input' }

function content(args: Record<string, unknown>, key: string, example: Record<string, unknown>): string {
  return readString(args, key, { max: MAX_TEXT, example }) ?? ''
}

export const textTools: ToolEntry[] = [
  {
    name: 'text_stats', category: 'text', effect: 'read',
    description: 'Count Unicode characters, words, lines and nonblank lines in up to 50,000 chars. Text defaults to @input; @note:<id> also works. Example: {"text":"@input"}',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    contentParams: { names: ['text'], defaultParam: 'text' },
    handler(args) {
      const text = content(args, 'text', textExample)
      const lines = text ? text.split(/\r\n|\r|\n/) : []
      return {
        characters: Array.from(text).length,
        utf16_units: text.length,
        words: (text.match(/[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu) ?? []).length,
        lines: lines.length,
        nonblank_lines: lines.filter((line) => line.trim().length > 0).length,
      }
    },
  },
  {
    name: 'transform_text', category: 'text', effect: 'read',
    description: 'Transform up to 50,000 chars; returns a bounded preview if long. Replace is literal, case-sensitive and replaces all matches. Text defaults to @input. Example: {"operation":"trim","text":"@input"}',
    parameters: {
      type: 'object', properties: {
        text: { type: 'string' }, operation: { type: 'string', enum: operations },
        find: { type: 'string' }, replacement: { type: 'string' },
      }, required: ['operation'],
    },
    contentParams: { names: ['text'], defaultParam: 'text' },
    handler(args) {
      const example = { operation: 'trim', text: '@input' }
      const text = content(args, 'text', example)
      const operation = readEnum(args, 'operation', operations, { required: true, example })!
      let result: string
      switch (operation) {
        case 'trim': result = text.trim(); break
        case 'lowercase': result = text.toLowerCase(); break
        case 'uppercase': result = text.toUpperCase(); break
        case 'collapse_whitespace': result = text.trim().replace(/\s+/g, ' '); break
        case 'sort_lines': result = text.split(/\r\n|\r|\n/).sort().join('\n'); break
        case 'dedupe_lines': result = [...new Set(text.split(/\r\n|\r|\n/))].join('\n'); break
        case 'replace': {
          const replaceExample = { operation: 'replace', text: '@input', find: 'old', replacement: 'new' }
          const find = readString(args, 'find', { required: true, max: 1000, example: replaceExample })!
          const replacement = readString(args, 'replacement', { max: 1000, example: replaceExample }) ?? ''
          const parts = text.split(find)
          const length = text.length + (parts.length - 1) * (replacement.length - find.length)
          if (length > 100_000) throw argError('Replacement result exceeds 100,000 chars; use a shorter replacement.', replaceExample)
          result = parts.join(replacement)
          break
        }
      }
      return fitJson({ operation, text: result, characters: Array.from(result).length })
    },
  },
  {
    name: 'compare_text', category: 'text', effect: 'read',
    description: 'Compare up to 50,000 chars and 3,000 lines per side. Reports positional line differences, not an edit script; excerpts may be clipped. Supports content refs. Example: {"left":"@input","right":"@note:Draft"}',
    parameters: {
      type: 'object', properties: {
        left: { type: 'string' }, right: { type: 'string' },
        ignore_case: { type: 'boolean' }, ignore_whitespace: { type: 'boolean' },
      }, required: ['left', 'right'],
    },
    contentParams: { names: ['left', 'right'] },
    handler(args) {
      const example = { left: 'before', right: 'after' }
      for (const key of ['left', 'right']) {
        if (!Object.hasOwn(args, key) || args[key] == null) throw argError(`"${key}" is required.`, example)
      }
      const left = content(args, 'left', example)
      const right = content(args, 'right', example)
      const foldCase = readBoolean(args, 'ignore_case', false)
      const foldSpace = readBoolean(args, 'ignore_whitespace', false)
      const normalize = (value: string) => {
        let result = foldCase ? value.toLowerCase() : value
        if (foldSpace) result = result.trim().replace(/\s+/g, ' ')
        return result
      }
      const leftLines = left ? left.split(/\r\n|\r|\n/) : []
      const rightLines = right ? right.split(/\r\n|\r|\n/) : []
      if (Math.max(leftLines.length, rightLines.length) > 3000) throw argError('Compare accepts at most 3,000 lines per side.', example)
      const differences: { line: number; left: string | null; right: string | null }[] = []
      let differentLines = 0
      for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
        const a = leftLines[i]
        const b = rightLines[i]
        if (a === undefined || b === undefined || normalize(a) !== normalize(b)) {
          differentLines++
          if (differences.length < 20) differences.push({ line: i + 1, left: a === undefined ? null : clipText(a, 160), right: b === undefined ? null : clipText(b, 160) })
        }
      }
      return fitJson({ equal: differentLines === 0, comparison: 'positional_lines', left_lines: leftLines.length, right_lines: rightLines.length, different_lines: differentLines, differences, truncated: differentLines > differences.length || differences.some((d) => (leftLines[d.line - 1]?.length ?? 0) > 160 || (rightLines[d.line - 1]?.length ?? 0) > 160) })
    },
  },
]
