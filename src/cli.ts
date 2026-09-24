import { parseArgs } from 'node:util'
import {
  AuthenticationError,
  AuthorizationError,
  InoreaderClient,
  InoreaderError,
  RateLimitError,
  TokenError,
  type Article,
} from 'inoreader-js'
import { budgetLine, loadArticles, loadBudget, recordBudget, saveArticles, type CachedArticle } from './cache.ts'
import { login } from './login.ts'
import { load, remove, save, storeLocation, type StoredAuth } from './store.ts'
import { WebError, WebSessionExpired } from './web.ts'
import { WEB_USAGE, webCommand } from './webcli.ts'

const USAGE = `inoreader — Inoreader API from the command line (JSON output)

Auth:
  auth login [--op op://vault/item] [--no-browser] [--read-only]
  auth status | auth logout

Read:
  user                              account info
  subs [--folder NAME]              subscriptions
  folders                           folders and tags with unread counts
  counts [--all]                    unread counts (non-zero unless --all)
  list [STREAM] [options]           articles in a stream (default: all)
      -n, --limit N                 max articles (default 20)
      --unread                      only unread
      --since 2d|12h|ISO-date       only newer than this
      --oldest                      oldest first
      --continuation TOKEN          resume from a previous page
      --full                        include article text (--html for raw HTML)
      --grep REGEX                  filter fetched items by title/source
  get ID...                         full article content (--html for raw HTML)

Local cache (the API allows ~100 read + ~100 write calls/day, so analyse offline):
  sync [STREAM] [--pages N] [--deep] [--unread] [--since ..] [--continuation T]
                                    fetch up to N×100 articles (default 3 pages) into the
                                    cache; stops early at already-cached items unless --deep
  cached [filters] [--group author|source|domain|tag] [--ids] [--full] [-n N]
      filters: --feed S  --author S  --tag NAME  --untagged  --unread  --grep RE  --since ..
                                    query the cache (no API calls). --ids prints bare ids,
                                    one per line, for piping into tag/read/etc.

Write (ID... may be "-" to read ids from stdin; batched 250 per call):
  read|unread|star|unstar ID...
  tag NAME ID...  |  untag NAME ID...
  mark-all-read STREAM [--before ISO-date]
  subscribe URL [--folder NAME] [--title TITLE]
  unsubscribe STREAM
  edit-sub STREAM [--title T] [--folder NAME] [--remove-folder NAME]
  rename-tag OLD NEW  |  delete-tag NAME

Web session (rules, filters, spotlights, settings the public API lacks; uses a
browser cookie, not the API quota):  inoreader web --help

Other:
  rate [--live]                     API budget as of the last call (--live: fresh, costs 1 read)
  raw GET|POST PATH [key=value...]  call any endpoint, e.g. raw GET /reader/api/0/user-info

STREAM: all | starred | saved | liked | annotated | read | tag:NAME | folder:NAME
        | feed:URL | a feed URL | any raw stream id (e.g. user/-/label/Tech)
ID: long form (tag:google.com,2005:reader/item/...) or as printed by \`list\`.

Env: INOREADER_APP_ID/INOREADER_APP_KEY or INOREADER_OP_ITEM (login only),
     INOREADER_REDIRECT_URI (default http://localhost:8765/callback),
     INOREADER_PROFILE, INOREADER_STORE=file, INOREADER_CREDENTIALS_FILE,
     INOREADER_WEB_DELAY_MS (min gap between web-session calls, default 750).
`

const STATE = 'user/-/state/com.google/'
const READ = `${STATE}read`
const STARRED = `${STATE}starred`

function streamId(s = 'all'): string {
  const named: Record<string, string> = {
    all: `${STATE}reading-list`,
    starred: STARRED,
    saved: `${STATE}saved-web-pages`,
    liked: `${STATE}like`,
    annotated: `${STATE}annotated`,
    read: READ,
  }
  if (named[s]) return named[s]
  const m = s.match(/^(tag|folder|label):(.+)$/)
  if (m) return `user/-/label/${m[2]}`
  if (s.startsWith('feed:')) return `feed/${s.slice(5)}`
  if (/^https?:\/\//.test(s)) return `feed/${s}`
  return s
}

function label(name: string): string {
  return name.startsWith('user/') ? name : `user/-/label/${name}`
}

function parseSince(s: string): number {
  const m = s.match(/^(\d+)([mhdw])$/)
  if (m) {
    const unit = { m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 'm' | 'h' | 'd' | 'w']
    return Math.floor(Date.now() / 1000) - Number(m[1]) * unit
  }
  const t = Date.parse(s)
  if (Number.isNaN(t)) throw new Error(`bad date/duration: ${s}`)
  return Math.floor(t / 1000)
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function compact(a: Article, content?: 'text' | 'html'): CachedArticle & { content?: string } {
  const cats = a.categories ?? []
  const out: CachedArticle & { content?: string } = {
    id: a.id,
    title: htmlToText(a.title ?? ''),
    url: a.canonical?.[0]?.href ?? a.alternate?.[0]?.href,
    source: a.origin?.title,
    sourceId: a.origin?.streamId,
    published: new Date(a.published * 1000).toISOString(),
    author: a.author || undefined,
    read: cats.some((c) => c.endsWith('/state/com.google/read')),
    starred: cats.some((c) => c.endsWith('/state/com.google/starred')),
    tags: cats.filter((c) => c.includes('/label/')).map((c) => c.slice(c.indexOf('/label/') + 7)),
  }
  if (content) out.content = content === 'html' ? a.summary?.content : htmlToText(a.summary?.content ?? '')
  return out
}

const CACHE_TEXT_CHARS = Number(process.env.INOREADER_CACHE_TEXT_CHARS ?? 4000)

function toCached(a: Article): CachedArticle {
  const { content, ...rest } = compact(a, 'text')
  return { ...rest, text: content?.slice(0, CACHE_TEXT_CHARS) }
}

// "-" in an id list means: read whitespace-separated ids from stdin.
async function expandIds(ids: string[]): Promise<string[]> {
  if (!ids.includes('-')) return ids
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const fromStdin = input.split(/\s+/).filter(Boolean)
  return [...new Set(ids.flatMap((i) => (i === '-' ? fromStdin : [i])))]
}

// Mirror a successful edit-tag into the cache so offline queries stay accurate.
function applyLocal(ids: string[], p: { a?: string; r?: string }): void {
  const cache = loadArticles()
  let touched = false
  for (const id of ids) {
    const art = cache.get(id)
    if (!art) continue
    touched = true
    for (const [stream, on] of [
      [p.a, true],
      [p.r, false],
    ] as const) {
      if (!stream) continue
      if (stream === READ) art.read = on
      else if (stream === STARRED) art.starred = on
      else if (stream.includes('/label/')) {
        const name = stream.slice(stream.indexOf('/label/') + 7)
        art.tags = on ? [...new Set([...art.tags, name])] : art.tags.filter((t) => t !== name)
      }
    }
  }
  if (touched) saveArticles(cache)
}

function domain(url?: string): string {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./, '')
  } catch {
    return '(none)'
  }
}

function print(x: unknown): void {
  if (x !== undefined) process.stdout.write(`${JSON.stringify(x, null, 2)}\n`)
}

function need(args: string[], n: number, what: string): void {
  if (args.length < n) throw new Error(`usage: ${what}`)
}

// Not every endpoint is wrapped by inoreader-js; reuse its request plumbing
// (auth headers, token refresh, rate-limit tracking, typed errors).
function request(client: InoreaderClient, method: 'GET' | 'POST', path: string, params?: Record<string, unknown>) {
  return (client as unknown as { makeRequest: (p: string, m: string, q?: unknown) => Promise<any> }).makeRequest(
    path,
    method,
    params,
  )
}

async function run(cmd: string, args: string[], o: Record<string, any>, client: InoreaderClient): Promise<unknown> {
  const tagEdit = async (ids: string[], p: { a?: string; r?: string }) => {
    ids = await expandIds(ids)
    let calls = 0
    for (let i = 0; i < ids.length; i += 250) {
      await client.editTag({ i: ids.slice(i, i + 250), ...p })
      calls++
    }
    applyLocal(ids, p)
    return { ok: true, count: ids.length, calls }
  }

  switch (cmd) {
    case 'user':
      return client.getUserInfo()

    case 'subs': {
      const { subscriptions } = await client.getSubscriptions()
      return subscriptions
        .filter((s) => !o.folder || s.categories.some((c) => c.label === o.folder))
        .map((s) => ({ id: s.id, title: s.title, url: s.url, site: s.htmlUrl, folders: s.categories.map((c) => c.label) }))
    }

    case 'folders': {
      const { tags } = await client.getTags({ types: 1, counts: 1 })
      return tags
        .filter((t) => t.id.includes('/label/'))
        .map((t) => ({ name: t.id.slice(t.id.indexOf('/label/') + 7), type: t.type, unread: t.unread_count }))
    }

    case 'counts': {
      const { unreadcounts } = await client.getUnreadCounts()
      return unreadcounts
        .filter((c) => o.all || c.count > 0)
        .sort((a, b) => b.count - a.count)
        .map((c) => ({ id: c.id, count: c.count }))
    }

    case 'list': {
      const limit = Number(o.limit ?? 20)
      const items: Article[] = []
      let continuation: string | undefined = o.continuation
      do {
        const page = await client.getStreamContents(streamId(args[0]), {
          n: Math.min(100, limit - items.length),
          xt: o.unread ? READ : undefined,
          ot: o.since ? parseSince(o.since) : undefined,
          r: o.oldest ? 'o' : undefined,
          c: continuation,
        })
        items.push(...page.items)
        continuation = page.continuation
      } while (continuation && items.length < limit)
      const re = o.grep ? new RegExp(o.grep, 'i') : undefined
      const content = o.html ? 'html' : o.full ? 'text' : undefined
      return {
        items: items.filter((a) => !re || re.test(`${a.title} ${a.origin?.title}`)).map((a) => compact(a, content)),
        continuation,
      }
    }

    case 'get': {
      need(args, 1, 'get ID...')
      const res = await request(client, 'POST', '/reader/api/0/stream/items/contents', { i: args })
      return (res?.items ?? []).map((a: Article) => compact(a, o.html ? 'html' : 'text'))
    }

    case 'sync': {
      const sid = streamId(args[0])
      const pages = Number(o.pages ?? 3)
      const cache = loadArticles()
      const known = new Set(cache.keys())
      let continuation: string | undefined = o.continuation
      let fetched = 0
      let added = 0
      let calls = 0
      do {
        const page = await client.getStreamContents(sid, {
          n: 100,
          xt: o.unread ? READ : undefined,
          ot: o.since ? parseSince(o.since) : undefined,
          c: continuation,
        })
        calls++
        for (const a of page.items) {
          if (!known.has(a.id)) added++
          cache.set(a.id, toCached(a))
        }
        fetched += page.items.length
        continuation = page.continuation
        // Newest-first: a page with nothing new means we've caught up.
        if (!o.deep && page.items.length && page.items.every((a) => known.has(a.id))) break
      } while (continuation && calls < pages)
      saveArticles(cache)
      return { stream: sid, calls, fetched, new: added, cached: cache.size, continuation }
    }

    case 'read':
    case 'unread':
    case 'star':
    case 'unstar':
      need(args, 1, `${cmd} ID...`)
      return tagEdit(args, {
        read: { a: READ },
        unread: { r: READ },
        star: { a: STARRED },
        unstar: { r: STARRED },
      }[cmd])

    case 'tag':
    case 'untag':
      need(args, 2, `${cmd} NAME ID...`)
      return tagEdit(args.slice(1), cmd === 'tag' ? { a: label(args[0]) } : { r: label(args[0]) })

    case 'mark-all-read':
      need(args, 1, 'mark-all-read STREAM')
      await client.markAllAsRead({
        s: streamId(args[0]),
        ts: o.before ? Math.floor(Date.parse(o.before) * 1000) : undefined,
      })
      return { ok: true }

    case 'subscribe': {
      need(args, 1, 'subscribe URL')
      const res = await request(client, 'POST', '/reader/api/0/subscription/quickadd', { quickadd: args[0] })
      if (res?.streamId && (o.folder || o.title)) {
        await client.editSubscription({ s: res.streamId, ac: 'edit', t: o.title, a: o.folder ? label(o.folder) : undefined })
      }
      return res
    }

    case 'unsubscribe':
      need(args, 1, 'unsubscribe STREAM')
      await client.editSubscription({ s: streamId(args[0]), ac: 'unfollow' })
      return { ok: true }

    case 'edit-sub':
      need(args, 1, 'edit-sub STREAM [--title T] [--folder NAME] [--remove-folder NAME]')
      await client.editSubscription({
        s: streamId(args[0]),
        ac: 'edit',
        t: o.title,
        a: o.folder ? label(o.folder) : undefined,
        r: o['remove-folder'] ? label(o['remove-folder']) : undefined,
      })
      return { ok: true }

    case 'rename-tag':
      need(args, 2, 'rename-tag OLD NEW')
      await client.renameTag(label(args[0]), args[1])
      return { ok: true }

    case 'delete-tag':
      need(args, 1, 'delete-tag NAME')
      await client.deleteTag(label(args[0]))
      return { ok: true }

    case 'rate':
      await client.getUserInfo()
      return recordBudget(client.getRateLimitInfo())

    case 'raw': {
      need(args, 2, 'raw GET|POST PATH [key=value...]')
      const params: Record<string, string[]> = {}
      for (const kv of args.slice(2)) {
        const i = kv.indexOf('=')
        if (i < 0) throw new Error(`expected key=value, got ${kv}`)
        ;(params[kv.slice(0, i)] ??= []).push(kv.slice(i + 1))
      }
      const res = await request(client, args[0].toUpperCase() as 'GET' | 'POST', args[1], params)
      return res ?? { ok: true }
    }

    default:
      throw new Error(`unknown command: ${cmd}\n\n${USAGE}`)
  }
}

// Commands that only touch local state — no login, no API budget.
function offline(cmd: string, o: Record<string, any>): unknown {
  if (cmd === 'rate') return loadBudget() ?? { error: 'no budget recorded yet — run any API command or `rate --live`' }

  // cmd === 'cached'
  const re = o.grep ? new RegExp(o.grep, 'i') : undefined
  const since = o.since ? new Date(parseSince(o.since) * 1000).toISOString() : undefined
  const has = (v: string | undefined, s: string) => (v ?? '').toLowerCase().includes(s.toLowerCase())
  const items = [...loadArticles().values()].filter(
    (a) =>
      (!o.feed || has(a.sourceId, o.feed) || has(a.source, o.feed)) &&
      (!o.author || has(a.author, o.author)) &&
      (!o.tag || a.tags.includes(o.tag)) &&
      (!o.untagged || a.tags.length === 0) &&
      (!o.unread || !a.read) &&
      (!since || a.published >= since) &&
      (!re || re.test(`${a.title}\n${a.author ?? ''}\n${a.text ?? ''}`)),
  )

  if (o.ids) {
    process.stdout.write(items.map((a) => `${a.id}\n`).join(''))
    return undefined
  }

  if (o.group) {
    const keyOf: Record<string, (a: CachedArticle) => string[]> = {
      author: (a) => [a.author ?? '(none)'],
      source: (a) => [a.source ?? '(none)'],
      domain: (a) => [domain(a.url)],
      tag: (a) => (a.tags.length ? a.tags : ['(untagged)']),
    }
    const fn = keyOf[o.group]
    if (!fn) throw new Error(`--group must be one of: ${Object.keys(keyOf).join(', ')}`)
    const groups = new Map<string, { key: string; count: number; unread: number; latest: string; tags: Record<string, number> }>()
    for (const a of items) {
      for (const key of fn(a)) {
        const g = groups.get(key) ?? { key, count: 0, unread: 0, latest: '', tags: {} }
        g.count++
        if (!a.read) g.unread++
        if (a.published > g.latest) g.latest = a.published
        for (const t of a.tags) g.tags[t] = (g.tags[t] ?? 0) + 1
        groups.set(key, g)
      }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count)
  }

  const limit = Number(o.limit ?? 50)
  return {
    total: items.length,
    items: items.slice(0, limit || undefined).map(({ text, ...a }) => (o.full ? { ...a, text } : a)),
  }
}

async function main(): Promise<void> {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      op: { type: 'string' },
      'no-browser': { type: 'boolean' },
      'read-only': { type: 'boolean' },
      folder: { type: 'string' },
      'remove-folder': { type: 'string' },
      title: { type: 'string' },
      all: { type: 'boolean' },
      limit: { type: 'string', short: 'n' },
      unread: { type: 'boolean' },
      since: { type: 'string' },
      before: { type: 'string' },
      oldest: { type: 'boolean' },
      continuation: { type: 'string' },
      full: { type: 'boolean' },
      html: { type: 'boolean' },
      grep: { type: 'string' },
      pages: { type: 'string' },
      deep: { type: 'boolean' },
      feed: { type: 'string' },
      author: { type: 'string' },
      tag: { type: 'string' },
      untagged: { type: 'boolean' },
      group: { type: 'string' },
      ids: { type: 'boolean' },
      live: { type: 'boolean' },
      // web session
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      file: { type: 'string', short: 'f' },
      'user-agent': { type: 'string' },
      type: { type: 'string' },
      kind: { type: 'string' },
      feeds: { type: 'string' },
      unfollow: { type: 'boolean' },
      raw: { type: 'boolean' },
    },
  })
  const [cmd, ...args] = positionals
  if (!cmd || (o.help && cmd !== 'web')) {
    process.stdout.write(USAGE)
    return
  }

  // Web-session commands use a browser cookie, not OAuth (see web.ts).
  if (cmd === 'web') {
    if (!args.length || o.help) {
      process.stdout.write(WEB_USAGE)
      return
    }
    return print(await webCommand(args, o))
  }

  if (cmd === 'auth') {
    const sub = args[0] ?? 'status'
    if (sub === 'login') return login({ op: o.op, noBrowser: o['no-browser'], readOnly: o['read-only'] })
    if (sub === 'logout') {
      remove()
      return print({ ok: true })
    }
    if (sub === 'status') {
      const s = load()
      return print({
        loggedIn: !!s?.refreshToken,
        store: storeLocation(),
        scope: s?.scope,
        accessTokenExpires: s?.expiresAt ? new Date(s.expiresAt).toISOString() : undefined,
      })
    }
    throw new Error(`unknown auth subcommand: ${sub}`)
  }

  if (cmd === 'cached' || (cmd === 'rate' && !o.live)) return print(offline(cmd, o))

  const stored = load()
  if (!stored?.refreshToken) throw new Error('not logged in — run: inoreader auth login')
  const { clientId, clientSecret, redirectUri, ...tokens } = stored
  const client = new InoreaderClient({ clientId, clientSecret, redirectUri })
  client.setCredentials(tokens)
  try {
    print(await run(cmd, args, o, client))
  } finally {
    const budget = recordBudget(client.getRateLimitInfo())
    if (budget) process.stderr.write(`${budgetLine(budget)}\n`)
    // The library refreshes expired tokens transparently; persist the new ones.
    const now = client.getCredentials()
    if (now.accessToken && now.accessToken !== stored.accessToken) {
      const { authType: _authType, ...fresh } = now
      save({ ...stored, ...fresh } as StoredAuth)
    }
  }
}

main().catch((e: unknown) => {
  const out: Record<string, unknown> = { error: (e as Error).message }
  if (e instanceof WebSessionExpired) {
    out.type = 'WebSessionExpired'
    out.hint = e.hint
  } else if (e instanceof WebError) out.type = 'WebError'
  if (e instanceof InoreaderError) {
    out.type = e.constructor.name
    if (e.status) out.status = e.status
    if (e.details) out.details = e.details
    if (e instanceof AuthenticationError || e instanceof TokenError) out.hint = 'run: inoreader auth login'
    if (e instanceof AuthorizationError) {
      out.hint = 'insufficient permissions — the API may need an Inoreader Pro plan, or re-login without --read-only'
    }
    if (e instanceof RateLimitError) out.hint = `rate limited; resets in ${e.resetAfter}s`
  }
  process.stderr.write(`${JSON.stringify(out, null, 2)}\n`)
  process.exit(1)
})
