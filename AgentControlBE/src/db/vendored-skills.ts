import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Skill, SkillSourceId, SkillSourceInfo } from '../shared/types.js'
import { VENDORED_SKILL_SOURCES } from '../shared/types.js'
import { parseSkillMarkdown, SkillMarkdownError } from './skill-md.js'

/**
 * Third-party skills vendored at pinned commits by scripts/vendor-skills.mjs
 * into skills-vendor/<source>/<skill>/. Bodies stay on disk: the store keeps
 * metadata only and is rehydrated from here at boot. Only skills listed in
 * lock.json are loaded, so a stray folder never becomes a skill.
 */

export interface VendorManifestSource {
  id: SkillSourceId
  repo: string
  commit: string
  dir: string
  license: string
  include?: '*' | string[]
  exclude?: string[]
}

export interface VendorManifest {
  sources: VendorManifestSource[]
  defaults: Record<string, '*' | string[]>
}

interface VendorLock {
  sources: { id: string; commit: string; skills: { name: string; sha256: string }[] }[]
}

export interface VendoredLibrary {
  dir: string
  manifest: VendorManifest | null
  skills: Skill[]
  /** One entry per vendored source (repo, commit, license, count). */
  sources: SkillSourceInfo[]
  /** Skills that failed to load (spec violations, missing files). */
  problems: string[]
}

/** The 4 proprietary Anthropic skills; never vendored. */
export const PROPRIETARY_SKILLS: Record<string, string[]> = { anthropics: ['docx', 'pdf', 'pptx', 'xlsx'] }

const SOURCE_TAGS: Record<string, string> = { superpowers: 'Superpowers', anthropics: 'Anthropic', ecc: 'ECC' }
const SCRIPT_FILE = /\.(py|sh|bash|js|mjs|cjs|ts|rb|pl|ps1)$/i

export const DEFAULT_VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills-vendor')

/** `AGENTCONTROL_SKILLS_VENDOR_DIR` overrides the folder; `off` loads none. */
export function vendorDir(): string | null {
  const env = process.env.AGENTCONTROL_SKILLS_VENDOR_DIR
  if (env === 'off') return null
  return env && env.trim() ? env : DEFAULT_VENDOR_DIR
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

export function isDefaultOn(manifest: VendorManifest | null, sourceId: string, name: string): boolean {
  const rule = manifest?.defaults?.[sourceId]
  return rule === '*' || (Array.isArray(rule) && rule.includes(name))
}

export function loadVendoredLibrary(dir: string | null): VendoredLibrary {
  const empty: VendoredLibrary = { dir: dir ?? '', manifest: null, skills: [], sources: [], problems: [] }
  if (!dir || !existsSync(join(dir, 'manifest.json'))) return empty
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as VendorManifest
  const lockPath = join(dir, 'lock.json')
  const lock: VendorLock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, 'utf8')) as VendorLock) : { sources: [] }
  const library: VendoredLibrary = { ...empty, manifest }
  for (const source of manifest.sources) {
    if (!VENDORED_SKILL_SOURCES.includes(source.id)) {
      library.problems.push(`${source.id}: unknown source id`)
      continue
    }
    const locked = lock.sources.find((s) => s.id === source.id)
    let count = 0
    for (const { name } of locked?.skills ?? []) {
      const id = `${source.id}/${name}`
      if ((PROPRIETARY_SKILLS[source.id] ?? []).includes(name) || (source.exclude ?? []).includes(name)) {
        library.problems.push(`${id}: excluded`)
        continue
      }
      const skillDir = join(dir, source.id, name)
      const mdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(mdPath)) {
        library.problems.push(`${id}: SKILL.md missing`)
        continue
      }
      try {
        const parsed = parseSkillMarkdown(readFileSync(mdPath, 'utf8'), { folder: name })
        const files = listFiles(skillDir)
        const skill: Skill = {
          id,
          name: parsed.name,
          description: parsed.description,
          tag: SOURCE_TAGS[source.id] ?? source.id,
          content: parsed.content,
          // Third-party skills never grant built-in tools, whatever their `tools:` says.
          tools: [],
          source: source.repo,
          sourceId: source.id,
          sourceRepo: source.repo,
          sourceCommit: source.commit,
          license: parsed.license ?? source.license,
          ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
          ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
          ...(parsed.allowedTools ? { allowedTools: parsed.allowedTools } : {}),
          hasScripts: files.some((f) => f.startsWith('scripts/') || SCRIPT_FILE.test(f)),
          files,
          defaultOn: isDefaultOn(manifest, source.id, name),
        }
        library.skills.push(skill)
        count++
      } catch (err) {
        if (!(err instanceof SkillMarkdownError)) throw err
        library.problems.push(`${id}: ${err.message}`)
      }
    }
    library.sources.push({ id: source.id, repo: source.repo, commit: source.commit, license: source.license, count })
  }
  return library
}

let cache: VendoredLibrary | null = null

/** The vendored library for the current `vendorDir()`, loaded once per folder. */
export function vendoredLibrary(): VendoredLibrary {
  const dir = vendorDir()
  if (!cache || cache.dir !== (dir ?? '')) cache = loadVendoredLibrary(dir)
  return cache
}

export const isVendoredSkillId = (id: string): boolean =>
  VENDORED_SKILL_SOURCES.some((source) => id.startsWith(`${source}/`))
