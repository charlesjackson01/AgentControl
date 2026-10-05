import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Encrypted at-rest storage for endpoint API keys.
 *
 * Keys are held in a JSON map encrypted with AES-256-GCM. The 32-byte master
 * key is resolved in this order:
 *   1. `AGENTCONTROL_SECRET` env var -> sha256(secret). Best for deployment.
 *   2. `vault.key` next to the vault, wrapped with Windows DPAPI (CurrentUser)
 *      so it is only decryptable by this OS account.
 *   3. Fallback: `vault.key` in plain base64 (logged as a warning).
 *
 * The vault file and key file live under `data/` (gitignored); `store.json`
 * never contains key material.
 */

const SECRET_ENV = 'AGENTCONTROL_SECRET'

interface VaultFile {
  v: number
  iv: string
  tag: string
  data: string
}

interface KeyFile {
  v: number
  protection: 'dpapi' | 'plain'
  key: string
}

export interface Vault {
  load(): Record<string, string>
  save(keys: Record<string, string>): void
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** Run a PowerShell snippet and return the last non-empty output line. */
function powershell(script: string): string {
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  )
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

function dpapiProtect(key: Buffer): string | null {
  if (process.platform !== 'win32') return null
  const b64 = key.toString('base64')
  const script =
    `Add-Type -AssemblyName System.Security; ` +
    `$b=[Convert]::FromBase64String('${b64}'); ` +
    `$e=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Convert]::ToBase64String($e)`
  try {
    return powershell(script)
  } catch {
    return null
  }
}

function dpapiUnprotect(blob: string): Buffer | null {
  if (process.platform !== 'win32') return null
  const script =
    `Add-Type -AssemblyName System.Security; ` +
    `$e=[Convert]::FromBase64String('${blob}'); ` +
    `$b=[System.Security.Cryptography.ProtectedData]::Unprotect($e,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Convert]::ToBase64String($b)`
  try {
    return Buffer.from(powershell(script), 'base64')
  } catch {
    return null
  }
}

function writeKeyFile(keyPath: string, key: Buffer): void {
  mkdirSync(dirname(keyPath), { recursive: true })
  const protectedBlob = dpapiProtect(key)
  if (protectedBlob) {
    const file: KeyFile = { v: 1, protection: 'dpapi', key: protectedBlob }
    writeFileSync(keyPath, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
    return
  }
  console.warn(
    `[vault] DPAPI unavailable; master key stored unencrypted at ${keyPath}. ` +
      `Set ${SECRET_ENV} to keep the key out of the filesystem.`,
  )
  const file: KeyFile = { v: 1, protection: 'plain', key: key.toString('base64') }
  writeFileSync(keyPath, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
}

function readKeyFile(keyPath: string): Buffer | null {
  try {
    const file = JSON.parse(readFileSync(keyPath, 'utf8')) as KeyFile
    if (file.protection === 'dpapi') return dpapiUnprotect(file.key)
    return Buffer.from(file.key, 'base64')
  } catch {
    return null
  }
}

function resolveMasterKey(keyPath: string): Buffer {
  const secret = process.env[SECRET_ENV]
  if (secret) return sha256(secret)

  if (existsSync(keyPath)) {
    const existing = readKeyFile(keyPath)
    if (!existing || existing.length !== 32) {
      throw new Error(
        `Could not read the vault key at ${keyPath}. Restore the key or set ${SECRET_ENV}.`,
      )
    }
    return existing
  }

  const fresh = randomBytes(32)
  writeKeyFile(keyPath, fresh)
  return fresh
}

export function createVault(vaultPath: string, keyPath: string): Vault {
  let cachedKey: Buffer | null = null
  const masterKey = (): Buffer => (cachedKey ??= resolveMasterKey(keyPath))

  return {
    load(): Record<string, string> {
      if (!existsSync(vaultPath)) return {}
      try {
        const file = JSON.parse(readFileSync(vaultPath, 'utf8')) as VaultFile
        const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(file.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(file.tag, 'base64'))
        const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()])
        return JSON.parse(plain.toString('utf8')) as Record<string, string>
      } catch (err) {
        throw new Error(
          `Could not decrypt ${vaultPath}. Wrong ${SECRET_ENV}/key? ` +
            `(${err instanceof Error ? err.message : 'decrypt failed'})`,
        )
      }
    },

    save(keys: Record<string, string>): void {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', masterKey(), iv)
      const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(keys), 'utf8')), cipher.final()])
      const file: VaultFile = {
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }
      mkdirSync(dirname(vaultPath), { recursive: true })
      writeFileSync(vaultPath, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 })
    },
  }
}
