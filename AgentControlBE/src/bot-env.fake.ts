/**
 * Test-only: a tiny in-memory podman for BotEnvService tests (BE-P2-4). Not used at run time.
 */
import { readFileSync } from 'node:fs'
import type { CommandResult, CommandRunner } from './command-runner.js'
import { baseImageFor } from './vm-images.js'

export const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
export const err = (stderr: string, code = 125): CommandResult => ({ code, stdout: '', stderr })

interface FakeImage { id: string; labels: Record<string, string> }
interface FakeContainer { imageId: string; labels: Record<string, string>; running: boolean; argv: string[] }

/** A tiny podman: images, containers and volumes in memory; `build` reads the LABEL lines of the Containerfile. */
export function fakeEngine(opts: { globalArgs?: string[]; failBuild?: boolean } = {}) {
  const images = new Map<string, FakeImage>()
  const containers = new Map<string, FakeContainer>()
  const volumes = new Set<string>()
  const calls: string[][] = []
  let nextId = 1
  const newId = () => (nextId++).toString(16).padStart(64, '0')
  for (const v of ['1.0.0', '1.1.0']) {
    images.set(baseImageFor('base', v), { id: newId(), labels: { 'io.agentcontrol.version': v } })
  }
  const g = opts.globalArgs ?? []
  const execHandler: { fn: (argv: string[]) => CommandResult } = { fn: () => ok() }

  const exec: CommandRunner = async (cmd, args) => {
    if (cmd !== 'podman') throw new Error(`fake engine: unexpected cli ${cmd}`)
    if (JSON.stringify(args.slice(0, g.length)) !== JSON.stringify(g)) throw new Error(`fake engine: missing global args in ${args.join(' ')}`)
    const a = args.slice(g.length)
    calls.push([...a])
    const [verb, sub] = a
    const flag = (name: string) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : undefined }
    if (verb === 'container' && sub === 'inspect') {
      const c = containers.get(a[2]!)
      if (!c) return err(`Error: no such container ${a[2]}`)
      return ok(JSON.stringify([{ Image: c.imageId, State: { Status: c.running ? 'running' : 'exited', Running: c.running }, Config: { Labels: c.labels } }]))
    }
    if (verb === 'image' && sub === 'inspect') {
      const i = images.get(a[2]!)
      return i ? ok(JSON.stringify([{ Id: i.id, Labels: i.labels }])) : err(`Error: ${a[2]}: image not known`)
    }
    if (verb === 'image' && sub === 'ls') {
      const ref = flag('--filter')!.replace('reference=', '')
      return ok([...images.keys()].filter((k) => k.startsWith(`${ref}:`)).join('\n'))
    }
    if (verb === 'volume') {
      const name = a[a.length - 1]!
      if (sub === 'inspect') return volumes.has(name) ? ok('[{}]') : err(`Error: no such volume ${name}`)
      if (sub === 'create') { volumes.add(name); return ok(name) }
      if (sub === 'rm') { if (!volumes.delete(name)) return err(`Error: no such volume ${name}`); return ok(name) }
    }
    if (verb === 'build') {
      if (opts.failBuild) return err('E: Unable to locate package nope', 100)
      const file = readFileSync(flag('--file')!, 'utf8')
      const labels: Record<string, string> = {}
      for (const line of file.split('\n').filter((l) => l.startsWith('LABEL '))) {
        for (const m of line.matchAll(/(\S+)="([^"]*)"/g)) labels[m[1]!] = m[2]!
      }
      const from = /^FROM (\S+)/m.exec(file)![1]!
      if (!images.has(from)) return err(`Error: ${from}: image not known`)
      images.set(flag('--tag')!, { id: newId(), labels })
      return ok('STEP 1/2: FROM ...\nCOMMIT')
    }
    if (verb === 'rmi') {
      const ref = a[1]!
      const img = images.get(ref)
      if (!img) return err(`Error: ${ref}: image not known`)
      if ([...containers.values()].some((c) => c.imageId === img.id)) return err('Error: image used by a container')
      images.delete(ref)
      return ok()
    }
    if (verb === 'create') {
      const name = flag('--name')!
      if (containers.has(name)) return err('Error: name in use')
      const ref = a[a.length - 1]!
      const img = images.get(ref)
      if (!img) return err(`Error: ${ref}: image not known`)
      const labels: Record<string, string> = {}
      a.forEach((x, i) => { if (x === '--label') { const [k, v] = a[i + 1]!.split('='); labels[k!] = v! } })
      containers.set(name, { imageId: img.id, labels, running: false, argv: [...a] })
      return ok('cid')
    }
    if (verb === 'rm') {
      const name = a[a.length - 1]!
      if (!containers.delete(name)) return err(`Error: no container with name or ID "${name}" found: no such container`)
      return ok()
    }
    if (verb === 'start' || verb === 'stop') {
      const c = containers.get(a[a.length - 1]!)
      if (!c) return err('Error: no such container')
      c.running = verb === 'start'
      return ok()
    }
    if (verb === 'exec') return execHandler.fn(a)
    return err(`fake: unhandled ${a.join(' ')}`, 2)
  }
  return { exec, images, containers, volumes, calls, execHandler }
}

