#!/usr/bin/env node
/**
 * Vendors third-party skills at the commits pinned in
 * AgentControlBE/skills-vendor/manifest.json.
 *
 *   node scripts/vendor-skills.mjs           fetch, copy, write or verify lock.json
 *   node scripts/vendor-skills.mjs --check   offline: hash what is on disk against lock.json
 *   node scripts/vendor-skills.mjs --update  like the default, but rewrite lock entries that differ
 *
 * Only `<dir>/<skill>/` is copied (dot-entries dropped), plus the repo's
 * LICENSE / NOTICE files. A source whose commit matches lock.json must hash
 * exactly as locked; a changed commit rewrites that source's lock entry.
 * Set VENDOR_SKILLS_CACHE to a folder holding `<owner>_<repo>.tgz` tarballs
 * to skip the download.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'AgentControlBE', 'skills-vendor')
const PROPRIETARY = { anthropics: ['docx', 'pdf', 'pptx', 'xlsx'] }
const ROOT_FILES = /^(LICENSE|NOTICE|THIRD_PARTY_NOTICES)(\.[A-Za-z]+)?$/

const args = new Set(process.argv.slice(2))
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'))
const lockPath = join(ROOT, 'lock.json')
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { sources: [] }

function fail(message) {
  console.error(`vendor-skills: ${message}`)
  process.exit(1)
}

/** Every file under `dir`, relative, forward slashes, sorted. */
function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out.sort()
}

/** sha256 over "<path>\0<file sha256>\n" for each file in order. */
function hashSkillDir(dir) {
  const h = createHash('sha256')
  for (const file of listFiles(dir)) {
    const fileHash = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')
    h.update(`${file}\0${fileHash}\n`)
  }
  return h.digest('hex')
}

function checkManifest() {
  const ids = new Set()
  for (const source of manifest.sources) {
    if (ids.has(source.id)) fail(`duplicate source id "${source.id}"`)
    ids.add(source.id)
    if (!/^[0-9a-f]{40}$/.test(source.commit)) fail(`${source.id}: commit must be a full 40-character sha`)
    for (const name of PROPRIETARY[source.id] ?? []) {
      if (!(source.exclude ?? []).includes(name)) fail(`${source.id}: proprietary skill "${name}" must be excluded`)
    }
  }
}

function wanted(source, name) {
  if ((PROPRIETARY[source.id] ?? []).includes(name)) return false
  if ((source.exclude ?? []).includes(name)) return false
  if (source.include === '*' || source.include === undefined) return true
  return Array.isArray(source.include) && source.include.includes(name)
}

function copyFiltered(from, to) {
  // Dot-entries (.gitignore, .agents, .kiro, ...) are never vendored.
  cpSync(from, to, { recursive: true, filter: (src) => src === from || !src.split(sep).pop().startsWith('.') })
}

function fetchSource(source, work) {
  const tarball = join(work, `${source.id}.tgz`)
  const cached = process.env.VENDOR_SKILLS_CACHE && join(process.env.VENDOR_SKILLS_CACHE, `${source.repo.replace('/', '_')}.tgz`)
  if (cached && existsSync(cached)) cpSync(cached, tarball)
  else execFileSync('curl', ['-sSfL', '-o', tarball, `https://codeload.github.com/${source.repo}/tar.gz/${source.commit}`], { stdio: 'inherit' })
  const out = join(work, source.id)
  mkdirSync(out)
  execFileSync('tar', ['-xzf', tarball, '-C', out, '--strip-components=1'])
  return out
}

function vendor() {
  checkManifest()
  const work = mkdtempSync(join(tmpdir(), 'vendor-skills-'))
  const nextLock = { sources: [] }
  try {
    for (const source of manifest.sources) {
      const repo = fetchSource(source, work)
      const skillsDir = join(repo, source.dir)
      const names = readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && wanted(source, e.name))
        .map((e) => e.name)
        .sort()
      const dest = join(ROOT, source.id)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      for (const file of readdirSync(repo)) if (ROOT_FILES.test(file)) cpSync(join(repo, file), join(dest, file))
      const skills = []
      for (const name of names) {
        if (!existsSync(join(skillsDir, name, 'SKILL.md'))) continue
        copyFiltered(join(skillsDir, name), join(dest, name))
        skills.push({ name, sha256: hashSkillDir(join(dest, name)) })
      }
      const entry = { id: source.id, commit: source.commit, skills }
      const locked = lock.sources.find((s) => s.id === source.id)
      if (locked && locked.commit === source.commit && JSON.stringify(locked.skills) !== JSON.stringify(skills) && !args.has('--update')) {
        fail(`${source.id}: content at ${source.commit.slice(0, 7)} does not match lock.json (rerun with --update to accept)`)
      }
      nextLock.sources.push(entry)
      console.log(`${source.id}: ${skills.length} skills at ${source.commit.slice(0, 7)}`)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  writeFileSync(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`)
  console.log(`total: ${nextLock.sources.reduce((n, s) => n + s.skills.length, 0)} skills`)
}

function check() {
  checkManifest()
  let problems = 0
  for (const source of manifest.sources) {
    const locked = lock.sources.find((s) => s.id === source.id)
    if (!locked) { console.error(`${source.id}: not in lock.json`); problems++; continue }
    if (locked.commit !== source.commit) { console.error(`${source.id}: lock is at ${locked.commit.slice(0, 7)}, manifest at ${source.commit.slice(0, 7)}`); problems++ }
    const dest = join(ROOT, source.id)
    const onDisk = existsSync(dest) ? readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []
    const lockedNames = locked.skills.map((s) => s.name)
    for (const name of onDisk) if (!lockedNames.includes(name)) { console.error(`${source.id}/${name}: on disk but not locked`); problems++ }
    for (const { name, sha256 } of locked.skills) {
      if (!wanted(source, name)) { console.error(`${source.id}/${name}: locked but excluded`); problems++; continue }
      if (!existsSync(join(dest, name))) { console.error(`${source.id}/${name}: missing`); problems++; continue }
      if (hashSkillDir(join(dest, name)) !== sha256) { console.error(`${source.id}/${name}: hash mismatch`); problems++ }
    }
  }
  if (problems > 0) fail(`${problems} problem(s)`)
  console.log('lock.json verified')
}

if (args.has('--check')) check()
else vendor()
