// Reading, searching and marking articles through the web session (web.ts), for the
// `--via web` fallback, `search` and `--full-content`. Every call is paced by WebSession.
//
// Web functions used (from the web app's own code; verified live):
//   print_articles(false, <seen ids>|0, feed_params)      stream pages / search / one article
//   read_article({aid: 1|2}, 0, {}, false, 1|2)           1 = mark unread, 2 = mark read
//   set_fav(aid, 1|0, {progress: null})                   star ("Read later") / unstar
//   save_tags(aid, {tagId: name, <new key>: name})        replaces the article's own tags
//   mobilize(aid, 0|1, true, {})                          full content on / back off
//   fill_dialog('folder_info_dialog', {folder_id})        folder settings (keep-unread)
//   save_keep_unread_days(folder_id, days)                1..30, per folder

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDir } from './cache.ts'
import {
  aidFromOid,
  isNewsletter,
  oidFromAid,
  oidKeyOf,
  parseArticleRef,
  parseArticles,
  parseMobilize,
  parsePaging,
  type WebArticle,
} from './articles.ts'
import { extractMainText, htmlToText, looksTruncated } from './text.ts'
import { DEFAULT_USER_AGENT, WebError, WebSession, assigned, extractAutocomplete, jc, notifications, parseTagOptions, scripts } from './web.ts'

// ---------------------------------------------------------------------------
// oid key (see articles.ts): learned from any listed article, cached per profile.

const idsFile = () => join(cacheDir(), 'web-ids.json')

export function loadOidKey(): string | undefined {
  try {
    return JSON.parse(readFileSync(idsFile(), 'utf8')).oidKey
  } catch {
    return undefined
  }
}

export function learnOidKey(articles: WebArticle[]): void {
  const keys = new Set(articles.filter((a) => a.aid && /^[0-9a-f]{16}$/.test(a.oid)).map((a) => oidKeyOf(a.aid, a.oid)))
  if (keys.size !== 1) return
  const key = [...keys][0]
  if (loadOidKey() === key) return
  mkdirSync(cacheDir(), { recursive: true, mode: 0o700 })
  writeFileSync(idsFile(), JSON.stringify({ oidKey: key }), { mode: 0o600 })
}

async function page(s: WebSession, offset: unknown, params: Record<string, unknown>, referer: string) {
  const cmds = await s.read('print_articles', [false, offset, params], referer)
  const articles = parseArticles(cmds)
  learnOidKey(articles)
  return { cmds, articles, paging: parsePaging(cmds) }
}

export async function ensureOidKey(s: WebSession): Promise<string> {
  const known = loadOidKey()
  if (known) return known
  await page(s, 0, { filter_type: 'all_articles', view_unread: 0, view_style: 1, seen_ids: [] }, '/all_articles')
  const key = loadOidKey()
  if (!key) throw new WebError('could not learn the article id mapping (no articles listed)')
  return key
}

export async function toAid(s: WebSession, ref: string): Promise<string> {
  const r = parseArticleRef(ref)
  return r.kind === 'aid' ? r.aid : aidFromOid(r.oid, await ensureOidKey(s))
}

export async function getArticle(s: WebSession, ref: string): Promise<WebArticle | undefined> {
  const r = parseArticleRef(ref)
  const oid = r.kind === 'oid' ? r.oid : oidFromAid(r.aid, await ensureOidKey(s))
  const cmds = await s.read('print_articles', [1, 0, { filter_type: 'article', filter_id: oid, in_dialog: true, view_style: 1 }], '/all_articles')
  return parseArticles(cmds)[0]
}

// ---------------------------------------------------------------------------
// Streams

async function webTags(s: WebSession): Promise<{ id: string; name: string }[]> {
  const cmds = await s.read('get_rule_tags', ['tags_0', null], '/rules')
  return parseTagOptions(assigned(cmds, 'tags_0') ?? '').map(({ id, name }) => ({ id, name }))
}

// CLI stream syntax -> print_articles feed_params (all verified live).
export async function streamParams(s: WebSession, stream = 'all'): Promise<Record<string, unknown>> {
  const st = stream.trim()
  if (st === 'all' || st.endsWith('/state/com.google/reading-list')) return { filter_type: 'all_articles' }
  if (st === 'starred' || st.endsWith('/state/com.google/starred')) return { filter_type: 'starred' }
  let m = st.match(/^tag:(.+)$/)
  if (m) return { filter_type: 'tag', filter_url: m[1] }
  m = st.match(/^folder:(.+)$/)
  if (m) return { filter_type: 'folder', filter_url: m[1] }
  m = st.match(/^(?:label:|user\/[^/]+\/label\/)(.+)$/)
  if (m) {
    const isTag = (await webTags(s)).some((t) => t.name === m![1])
    return { filter_type: isTag ? 'tag' : 'folder', filter_url: m[1] }
  }
  m = st.match(/^feed[:/](.+)$/)
  if (m) return { filter_type: 'subscription', filter_url: m[1] }
  if (/^https?:\/\//.test(st)) return { filter_type: 'subscription', filter_url: st }
  throw new Error(`stream "${stream}" is not available through the web session (use all, starred, tag:, folder:, feed:)`)
}

export interface ListOptions {
  limit: number
  unread?: boolean
  since?: number // unix seconds
  oldest?: boolean
  stopWhen?: (pageArticles: WebArticle[]) => boolean
}

export async function listStream(s: WebSession, stream: string, o: ListOptions): Promise<{ items: WebArticle[]; calls: number }> {
  const base = {
    ...(await streamParams(s, stream)),
    view_unread: o.unread ? 1 : 0,
    view_style: 1,
    articles_order: o.oldest ? 1 : 0,
    seen_ids: [],
  }
  const items: WebArticle[] = []
  let offset: unknown = 0
  let next: Record<string, unknown> = {}
  let calls = 0
  for (;;) {
    const p = await page(s, offset, { ...base, ...next }, '/all_articles')
    calls++
    let fresh = p.articles.filter((a) => !items.some((x) => x.aid === a.aid))
    if (o.unread) fresh = fresh.filter((a) => !a.read)
    const inRange = o.since ? fresh.filter((a) => Date.parse(a.published) / 1000 >= o.since!) : fresh
    items.push(...inRange)
    const passedSince = !o.oldest && o.since !== undefined && fresh.some((a) => Date.parse(a.published) / 1000 < o.since!)
    if (items.length >= o.limit || !p.paging.hasMore || !p.articles.length || passedSince || o.stopWhen?.(p.articles)) break
    offset = p.paging.ids.map(Number)
    next = p.paging.next
  }
  return { items: items.slice(0, o.limit), calls }
}

// ---------------------------------------------------------------------------
// Search (Inoreader's full-text search; not available in the public API)

export const SEARCH_MATCH: Record<string, string> = { all: '0', any: '1', phrase: '2', advanced: '3' }
export const SEARCH_IN: Record<string, string> = { all: '0', content: '1', title: '2' }
export const SEARCH_ORDER: Record<string, string> = { newest: '0', oldest: '1', relevance: '2' }
// search_range: 1 = 24h, 2 = week, 3 = month, 4 = year, 5 = all time
export function searchRange(since?: number, now = Date.now() / 1000): string {
  if (!since) return '5'
  const age = now - since
  if (age <= 86400) return '1'
  if (age <= 7 * 86400) return '2'
  if (age <= 31 * 86400) return '3'
  if (age <= 366 * 86400) return '4'
  return '5'
}

export interface SearchOptions {
  limit: number
  stream?: string
  since?: number
  match?: string
  in?: string
  order?: string
  language?: string
  unread?: boolean
}

function pick(table: Record<string, string>, v: string | undefined, what: string, dflt: string): string {
  if (v === undefined) return dflt
  const hit = table[v.toLowerCase()]
  if (hit === undefined) throw new Error(`--${what} must be one of: ${Object.keys(table).join(', ')}`)
  return hit
}

async function searchScope(s: WebSession, stream?: string): Promise<{ search_filter_type: string; search_filter_id: string }> {
  if (!stream || stream === 'all') return { search_filter_type: '', search_filter_id: '' }
  if (stream === 'starred') return { search_filter_type: 'starred', search_filter_id: '' }
  const m = stream.match(/^(tag|folder|label):(.+)$/)
  if (m) {
    // Tags and folders are both "folders" to the search scope (tags have folder_type 0).
    const tag = (await webTags(s)).find((t) => t.name === m[2])
    if (tag) return { search_filter_type: 'folder', search_filter_id: tag.id }
  }
  const ac = extractAutocomplete(
    await s.read('fill_dialog', ['rule_dialog', { context: 'create_filter_btn', filter_id: '', filter_type: '', rule_type: '2' }], '/filters'),
  )
  if (m) {
    const f = ac?.folders.find((x) => x.title === m[2])
    if (f) return { search_filter_type: 'folder', search_filter_id: f.id }
    throw new Error(`no tag or folder named "${m[2]}"`)
  }
  const url = stream.replace(/^feed[:/]/, '')
  const sub = ac?.subscriptions.find((x) => x.rss_url === url || x.id === url)
  if (sub) return { search_filter_type: 'subscription', search_filter_id: sub.id }
  throw new Error(`--stream for search must be all, starred, tag:NAME, folder:NAME or feed:URL (not found: ${stream})`)
}

export async function search(s: WebSession, term: string, o: SearchOptions): Promise<{ items: WebArticle[]; calls: number }> {
  if (term.trim().length < 2) throw new Error('search term must be at least 2 characters')
  const base = {
    filter_type: 'search',
    filter_id: '0',
    search_term: term,
    search_ner_entities: '',
    search_options: 1,
    search_filters: pick(SEARCH_IN, o.in, 'in', '0'),
    search_match: pick(SEARCH_MATCH, o.match, 'match', '0'),
    search_order: pick(SEARCH_ORDER, o.order, 'order', '0'),
    search_range: searchRange(o.since),
    search_language: o.language ?? '',
    search_feed_popularity: '0',
    seen_ids: [],
    view_style: 1,
    ...(await searchScope(s, o.stream)),
  }
  const items: WebArticle[] = []
  let offset: unknown = 0
  let next: Record<string, unknown> = {}
  let calls = 0
  for (;;) {
    const p = await page(s, offset, { ...base, ...next }, '/search')
    calls++
    for (const a of p.articles) {
      if (items.some((x) => x.aid === a.aid)) continue
      if (o.unread && a.read) continue
      if (o.since && Date.parse(a.published) / 1000 < o.since) continue
      items.push(a)
    }
    if (items.length >= o.limit || !p.paging.hasMore || !p.articles.length) break
    offset = p.paging.ids.map(Number)
    next = p.paging.next
  }
  return { items: items.slice(0, o.limit), calls }
}

// ---------------------------------------------------------------------------
// Writes

export async function setRead(s: WebSession, aids: string[], read: boolean): Promise<number> {
  const flag = read ? 2 : 1
  let calls = 0
  for (let i = 0; i < aids.length; i += 250) {
    const batch = Object.fromEntries(aids.slice(i, i + 250).map((a) => [a, flag]))
    await s.write('read_article', [batch, 0, {}, false, flag], '/all_articles')
    calls++
  }
  return calls
}

export async function setStar(s: WebSession, aids: string[], on: boolean): Promise<number> {
  for (const aid of aids) await s.write('set_fav', [Number(aid), on ? 1 : 0, { progress: null }], '/all_articles')
  return aids.length
}

const newTagKey = () => Array.from({ length: 8 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')

// Adds or removes one tag on each article. save_tags replaces the article's whole tag
// set, so each article's current tags are read first (1 read + 1 write per article).
export async function editTag(s: WebSession, refs: string[], name: string, add: boolean): Promise<{ calls: number; changed: number }> {
  const known = (await webTags(s)).find((t) => t.name === name)
  let calls = 1
  let changed = 0
  for (const ref of refs) {
    const a = await getArticle(s, ref)
    calls++
    if (!a) throw new WebError(`article not found: ${ref}`)
    const tags = { ...a.tagIds }
    const has = Object.entries(tags).find(([, n]) => n === name)
    if (add === !!has) continue
    if (add) tags[known?.id ?? newTagKey()] = name
    else delete tags[has![0]]
    await s.write('save_tags', [Number(a.aid), tags], '/all_articles')
    calls++
    changed++
  }
  return { calls, changed }
}

// ---------------------------------------------------------------------------
// Full content

export type ContentSource = 'inoreader' | 'inoreader-full' | 'original' | 'summary'

export interface FullContent {
  text: string
  html?: string
  contentSource: ContentSource
  note?: string
}

// Inoreader's "full content" (mobilize) for one article. mobilize remembers its state per
// article, so a previously off state is switched back off afterwards.
export async function mobilizeContent(s: WebSession, aid: string, wasMobilized?: boolean): Promise<string | undefined> {
  let was = wasMobilized
  if (was === undefined) {
    const a = await getArticle(s, aid)
    if (!a) return undefined
    if (a.mobilized && a.contentHtml && !looksTruncated(htmlToText(a.contentHtml))) return a.contentHtml
    was = a.mobilized
  }
  const res = parseMobilize(await s.read('mobilize', [Number(aid), 0, true, {}], '/all_articles'))
  if (!was) await s.read('mobilize', [Number(aid), 1, true, {}], '/all_articles')
  return res.html
}

export const ORIGINAL_TIMEOUT_MS = Number(process.env.INOREADER_FETCH_TIMEOUT_MS ?? 15000)

export async function fetchOriginal(url: string, doFetch: typeof fetch = fetch): Promise<string | undefined> {
  if (!/^https?:\/\//.test(url) || /\/\/(www\.)?inoreader\.com\//.test(url)) return undefined
  const res = await doFetch(url, {
    headers: { 'user-agent': DEFAULT_USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(ORIGINAL_TIMEOUT_MS),
  })
  if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? '')) return undefined
  const html = await res.text()
  return html.length > 5_000_000 ? html.slice(0, 5_000_000) : html
}

export interface ContentInput {
  aid?: string
  url?: string
  html?: string
  sourceId?: string
  feedType?: string
  mobilized?: boolean
}

// A candidate replaces the stored body when it is real text (>= 200 chars) and not much
// shorter than what we have: excerpts are often padded with metadata (points, comments),
// so "longer" alone would reject genuine full articles of short posts.
export function acceptable(candidate: string, stored: string): boolean {
  return candidate.length >= 200 && candidate.length >= stored.length * 0.5
}

// Stored body if it looks complete; else Inoreader's full content; else the original page.
export async function fullContent(a: ContentInput, s: WebSession | undefined, doFetch: typeof fetch = fetch): Promise<FullContent> {
  const stored = htmlToText(a.html ?? '')
  if (isNewsletter(a) || !looksTruncated(stored)) return { text: stored, html: a.html, contentSource: 'inoreader' }
  const notes: string[] = []
  if (s && a.aid) {
    try {
      const html = await mobilizeContent(s, a.aid, a.mobilized)
      const text = html ? htmlToText(html) : ''
      if (acceptable(text, stored)) return { text, html, contentSource: 'inoreader-full' }
      notes.push(text ? 'inoreader full content was too short' : 'inoreader had no full content')
    } catch (e) {
      notes.push(`inoreader full content failed: ${(e as Error).message}`)
    }
  }
  if (a.url) {
    try {
      const page = await fetchOriginal(a.url, doFetch)
      const text = page ? extractMainText(page).text : ''
      if (acceptable(text, stored)) return { text, contentSource: 'original' }
      notes.push(page ? 'original page had too little text' : 'original page not fetchable')
    } catch (e) {
      notes.push(`original fetch failed: ${(e as Error).message}`)
    }
  }
  return { text: stored, html: a.html, contentSource: 'summary', note: notes.join('; ') || undefined }
}

// ---------------------------------------------------------------------------
// Keep-unread days (per folder, 1..30; the server clamps other values)

export async function folderKeepUnread(s: WebSession, folderId: string): Promise<number | undefined> {
  const cmds = await s.read('fill_dialog', ['folder_info_dialog', { folder_id: Number(folderId) }], '/preferences/content/folders')
  for (const js of scripts(cmds)) {
    const m = js.match(/var value\s*=\s*"(\d+)"/)
    if (m && /keep_unread_days/.test(js)) return Number(m[1])
  }
  const html = assigned(cmds) ?? ''
  const m = html.match(/keep_unread_days_inline_value"[^>]*>\s*(\d+)/)
  return m ? Number(m[1]) : undefined
}

export async function setFolderKeepUnread(s: WebSession, folderId: string, days: number): Promise<string | undefined> {
  const cmds = await s.write('save_keep_unread_days', [Number(folderId), days], '/preferences/content/folders')
  return notifications(cmds)[0] ?? (jc(cmds, 'xalert')?.[0] as string | undefined)
}

export const KEEP_UNREAD_MAX = 30
