// Credential storage: macOS Keychain (via `security`), or a 0600 JSON file elsewhere.
// Everything (app id/key + OAuth tokens) lives in one blob so a normal run
// never needs 1Password or env vars — only `auth login` does.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface StoredAuth {
  clientId: string
  clientSecret: string
  redirectUri: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

const SERVICE = 'inoreader-cli'
const ACCOUNT = process.env.INOREADER_PROFILE || 'default'
const useKeychain = process.platform === 'darwin' && process.env.INOREADER_STORE !== 'file'
const filePath =
  process.env.INOREADER_CREDENTIALS_FILE ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'inoreader-cli', `${ACCOUNT}.json`)

export function storeLocation(): string {
  return useKeychain ? `macOS Keychain (service=${SERVICE}, account=${ACCOUNT})` : filePath
}

export function load(): StoredAuth | undefined {
  let raw: string
  if (useKeychain) {
    const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8' })
    if (r.status !== 0) return undefined
    raw = Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
  } else {
    try {
      raw = readFileSync(filePath, 'utf8')
    } catch {
      return undefined
    }
  }
  return JSON.parse(raw) as StoredAuth
}

export function save(auth: StoredAuth): void {
  const json = JSON.stringify(auth)
  if (useKeychain) {
    // Feed the command through `security -i` on stdin so the secret never appears in argv / `ps`.
    // Base64 keeps the value free of quotes and spaces.
    const b64 = Buffer.from(json, 'utf8').toString('base64')
    const cmd = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l ${SERVICE} -w ${b64}\n`
    const r = spawnSync('security', ['-i'], { input: cmd, encoding: 'utf8' })
    if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`keychain write failed: ${r.stderr.trim()}`)
    return
  }
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, json, { mode: 0o600 })
}

export function remove(): void {
  if (useKeychain) {
    spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { stdio: 'ignore' })
    return
  }
  rmSync(filePath, { force: true })
}
