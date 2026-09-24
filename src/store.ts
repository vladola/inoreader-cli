// Credential storage: macOS Keychain (via `security`), or a 0600 JSON file elsewhere.
// Everything (app id/key + OAuth tokens) lives in one blob so a normal run
// never needs 1Password or env vars — only `auth login` does.
// A second blob (account suffix "web") holds the web-session cookie; see web.ts.

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
const baseFile =
  process.env.INOREADER_CREDENTIALS_FILE ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'inoreader-cli', `${ACCOUNT}.json`)

function account(suffix?: string): string {
  return suffix ? `${ACCOUNT}:${suffix}` : ACCOUNT
}

function filePath(suffix?: string): string {
  return suffix ? baseFile.replace(/(\.json)?$/, `.${suffix}.json`) : baseFile
}

export function storeLocation(suffix?: string): string {
  return useKeychain ? `macOS Keychain (service=${SERVICE}, account=${account(suffix)})` : filePath(suffix)
}

export function loadBlob<T>(suffix?: string): T | undefined {
  let raw: string
  if (useKeychain) {
    const r = spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', account(suffix), '-w'], {
      encoding: 'utf8',
    })
    if (r.status !== 0) return undefined
    raw = Buffer.from(r.stdout.trim(), 'base64').toString('utf8')
  } else {
    try {
      raw = readFileSync(filePath(suffix), 'utf8')
    } catch {
      return undefined
    }
  }
  return JSON.parse(raw) as T
}

export function saveBlob(data: unknown, suffix?: string): void {
  const json = JSON.stringify(data)
  if (useKeychain) {
    // Feed the command through `security -i` on stdin so the secret never appears in argv / `ps`.
    // Base64 keeps the value free of quotes and spaces.
    const b64 = Buffer.from(json, 'utf8').toString('base64')
    const acct = account(suffix)
    const cmd = `add-generic-password -U -s ${SERVICE} -a ${acct} -l ${SERVICE} -w ${b64}\n`
    const r = spawnSync('security', ['-i'], { input: cmd, encoding: 'utf8' })
    if (r.status !== 0 || /error/i.test(r.stderr)) throw new Error(`keychain write failed: ${r.stderr.trim()}`)
    return
  }
  const file = filePath(suffix)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, json, { mode: 0o600 })
}

export function removeBlob(suffix?: string): void {
  if (useKeychain) {
    spawnSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account(suffix)], { stdio: 'ignore' })
    return
  }
  rmSync(filePath(suffix), { force: true })
}

export const load = (): StoredAuth | undefined => loadBlob<StoredAuth>()
export const save = (auth: StoredAuth): void => saveBlob(auth)
export const remove = (): void => removeBlob()
