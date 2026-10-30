/**
 * BE-P2-6: the `acfs` entry point inside the ac-storaged helper container
 * (Windows; PHASE2_PLAN §6). Reads one JSON request on stdin, answers one JSON
 * reply on stdout ('cat' streams the file's bytes instead). The volume root is
 * AC_FS_ROOT, /var/lib/agentcontrol by default. Exit code 0 even for refused
 * operations (the reply says why); 2 for a malformed request.
 *
 * The helper image (BE-P2-3) installs it as /usr/local/bin/acfs:
 *   #!/bin/sh
 *   exec node /opt/acfs/storage/acfs-cli.js
 */
import { handleAcfs, parseAcfsRequest, type AcfsResponse } from './acfs.js'
import { LocalFs } from './local-fs.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const fs = new LocalFs(process.env.AC_FS_ROOT || '/var/lib/agentcontrol')
  let req
  try {
    req = parseAcfsRequest(JSON.parse(await readStdin()))
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: { message: err instanceof Error ? err.message : String(err), statusCode: 400 } } satisfies AcfsResponse))
    process.exitCode = 2
    return
  }
  if (req.op === 'cat') {
    try {
      const { stream } = fs.openRead(req.root, req.parts)
      stream.pipe(process.stdout)
      stream.on('error', () => { process.exitCode = 1 })
    } catch (err) {
      process.stderr.write(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
    }
    return
  }
  process.stdout.write(JSON.stringify(handleAcfs(fs, req)))
}

void main()
