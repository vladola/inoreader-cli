// One-time OAuth 2.0 login: local callback server + browser consent.

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { InoreaderClient } from 'inoreader-js'
import { save, storeLocation, type StoredAuth } from './store.ts'

export const DEFAULT_REDIRECT = 'http://localhost:8765/callback'

// App credentials come from env vars, or from a 1Password item (`op` CLI) holding
// the App ID in `username` and the App key in `credential`.
function appCredentials(opItem?: string): { clientId: string; clientSecret: string } {
  const envId = process.env.INOREADER_APP_ID
  const envKey = process.env.INOREADER_APP_KEY
  if (envId && envKey) return { clientId: envId, clientSecret: envKey }

  const ref = opItem || process.env.INOREADER_OP_ITEM
  if (!ref) {
    throw new Error('need app credentials: set INOREADER_APP_ID + INOREADER_APP_KEY, or pass --op "op://<vault>/<item>"')
  }
  const read = (field: string) => {
    const r = spawnSync('op', ['read', '--no-newline', `${ref.replace(/\/$/, '')}/${field}`], {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    })
    if (r.status !== 0) throw new Error(`op read ${field} failed: ${r.stderr.trim()}`)
    return r.stdout
  }
  return { clientId: read('username'), clientSecret: read('credential') }
}

export async function login(opts: { op?: string; noBrowser?: boolean; readOnly?: boolean }): Promise<void> {
  const { clientId, clientSecret } = appCredentials(opts.op)
  const redirectUri = process.env.INOREADER_REDIRECT_URI || DEFAULT_REDIRECT
  const redirect = new URL(redirectUri)
  const client = new InoreaderClient({ clientId, clientSecret, redirectUri })
  const state = randomBytes(16).toString('hex')
  const authUrl = client.generateAuthUrl(opts.readOnly ? 'read' : 'read write', state)

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close()
      reject(new Error('timed out waiting for OAuth callback (5 min)'))
    }, 5 * 60_000)
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', redirect.origin)
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end()
        return
      }
      const finish = (status: number, msg: string, err?: Error) => {
        res.writeHead(status, { 'Content-Type': 'text/plain' }).end(msg)
        clearTimeout(timer)
        server.close()
        if (err) reject(err)
        else resolve(url.searchParams.get('code')!)
      }
      if (url.searchParams.get('state') !== state) return finish(400, 'State mismatch.', new Error('OAuth state mismatch'))
      if (!url.searchParams.get('code')) {
        const e = url.searchParams.get('error') || 'no code in callback'
        return finish(400, `Authorization failed: ${e}`, new Error(e))
      }
      finish(200, 'inoreader-cli: authorized. You can close this tab.')
    })
    server.on('error', reject)
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      process.stderr.write(`Open this URL to authorize:\n\n  ${authUrl}\n\nWaiting for callback on ${redirectUri} ...\n`)
      if (!opts.noBrowser && process.platform === 'darwin') spawnSync('open', [authUrl])
    })
  })

  const creds = await client.exchangeCodeForToken(code, state)
  const stored: StoredAuth = { clientId, clientSecret, redirectUri, ...creds }
  save(stored)
  const user = await client.getUserInfo()
  process.stderr.write(`Logged in as ${user.userName} (${user.userEmail}). Credentials saved to ${storeLocation()}.\n`)
}
