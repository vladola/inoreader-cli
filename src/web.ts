// Web-session transport: talks to the same xajax endpoint the Inoreader web app uses,
// authenticated with a browser cookie. This is an unofficial, undocumented interface —
// it covers what the public OAuth API can't (rules, filters, spotlights, some settings).
//
// Wire format (reverse-engineered from the web app):
//   POST https://www.inoreader.com/?xjxfun=<fn>
//   body: xjxfun=<fn>&xjxr=<ms>&xjxargs[]=<arg>&xjxargs[]=<arg>...
//   arg:  S<string> | N<number> | B<true|false> | * (null) | <JSON> (objects and arrays)
//   response: {"xjxobj":[{cmd:"as",id,prop,data} | {cmd:"js",data} | {cmd:"jc",func,data:[...]}]}

import { loadBlob, removeBlob, saveBlob, storeLocation } from './store.ts'

export const ORIGIN = 'https://www.inoreader.com'
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
export const LOGIN_HINT = 'pbpaste | inoreader web login'
const STORE_SUFFIX = 'web'

export interface WebCredentials {
  cookie: string
  userAgent: string
  savedAt: string
}

export type XjxCmd =
  | { cmd: 'as'; id: string; prop: string; data: string }
  | { cmd: 'js'; data: string }
  | { cmd: 'jc'; func: string; data: unknown[] }
  | { cmd: string; [k: string]: unknown }

export interface WebCall {
  fn: string
  args: unknown[]
  referer: string
}

export class WebSessionExpired extends Error {
  hint = `the web session is missing or expired — copy a fresh cookie and run: ${LOGIN_HINT}`
}

export class WebError extends Error {}

// ---------------------------------------------------------------------------
// Credentials

export const loadWebCredentials = (): WebCredentials | undefined => loadBlob<WebCredentials>(STORE_SUFFIX)
export const saveWebCredentials = (c: WebCredentials): void => saveBlob(c, STORE_SUFFIX)
export const removeWebCredentials = (): void => removeBlob(STORE_SUFFIX)
export const webStoreLocation = (): string => storeLocation(STORE_SUFFIX)

export function cookieNames(cookie: string): string[] {
  return cookie
    .split(/;\s*/)
    .map((p) => p.slice(0, p.indexOf('=')).trim())
    .filter(Boolean)
}

// Minimal POSIX-shell tokenizer, enough for DevTools "Copy as cURL (bash)" output:
// '...', "...", $'...', backslash escapes and backslash-newline continuations.
export function shellSplit(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let i = 0
  const s = input.replace(/\\\r?\n/g, ' ')
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      if (has) out.push(cur)
      cur = ''
      has = false
      i++
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) throw new Error('unterminated single quote in pasted command')
      cur += s.slice(i + 1, j)
      has = true
      i = j + 1
    } else if (c === '$' && s[i + 1] === "'") {
      i += 2
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1]
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
          i += 2
        } else cur += s[i++]
      }
      has = true
      i++
    } else if (c === '"') {
      i++
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1]
          i += 2
        } else cur += s[i++]
      }
      has = true
      i++
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1]
      has = true
      i += 2
    } else {
      cur += c
      has = true
      i++
    }
  }
  if (has) out.push(cur)
  return out
}

// Accepts a raw Cookie header value, a "cookie: ..." header line, or a pasted
// "Copy as cURL" command (-b/--cookie or -H 'cookie: ...'). Returns the cookie and,
// when the cURL command carries one, the browser's User-Agent.
export function parseCookieInput(input: string): { cookie: string; userAgent?: string } {
  const text = input.trim()
  if (!text) throw new Error('no input on stdin — paste a Cookie header or a "Copy as cURL" command')
  let cookie: string | undefined
  let userAgent: string | undefined
  if (/^curl(\s|$)/.test(text)) {
    const tokens = shellSplit(text)
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]
      const next = tokens[i + 1]
      if ((t === '-b' || t === '--cookie') && next !== undefined) {
        cookie = next
        i++
      } else if ((t === '-H' || t === '--header') && next !== undefined) {
        const m = next.match(/^([\w-]+):\s*(.*)$/s)
        if (m && m[1].toLowerCase() === 'cookie') cookie = m[2]
        if (m && m[1].toLowerCase() === 'user-agent') userAgent = m[2]
        i++
      } else if ((t === '-A' || t === '--user-agent') && next !== undefined) {
        userAgent = next
        i++
      }
    }
    if (!cookie) throw new Error('no cookie found in the cURL command (expected -b/--cookie or -H "cookie: ...")')
  } else {
    const line = text.split(/\r?\n/).find((l) => /^cookie:/i.test(l.trim()))
    cookie = line ? line.trim().replace(/^cookie:\s*/i, '') : text.replace(/^cookie:\s*/i, '')
  }
  cookie = cookie.trim().replace(/;\s*$/, '')
  if (/[\r\n]/.test(cookie) || !/^[^=;\s]+=/.test(cookie)) {
    throw new Error('input does not look like a Cookie header (expected "name=value; name2=value2")')
  }
  return { cookie, userAgent }
}

// ---------------------------------------------------------------------------
// Encoding / decoding

export function encodeArg(v: unknown): string {
  if (v === null || v === undefined) return '*'
  if (typeof v === 'object') return encodeURIComponent(JSON.stringify(v))
  if (typeof v === 'string') return `S${encodeURIComponent(v)}`
  if (typeof v === 'boolean') return `B${v}`
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`cannot encode non-finite number: ${v}`)
    return `N${v}`
  }
  throw new Error(`cannot encode argument of type ${typeof v}`)
}

export function encodeBody(fn: string, args: unknown[], now = Date.now()): string {
  return [`xjxfun=${encodeURIComponent(fn)}`, `xjxr=${now}`, ...args.map((a) => `xjxargs[]=${encodeArg(a)}`)].join('&')
}

// Inverse of encodeArg, for showing captured/dry-run calls in readable form.
export function decodeArg(s: string): unknown {
  if (s === '*') return null
  const v = decodeURIComponent(s)
  if (v[0] === 'S') return v.slice(1)
  if (v[0] === 'N') return Number(v.slice(1))
  if (v[0] === 'B') return v.slice(1) === 'true'
  return JSON.parse(v)
}

const LOGIN_JS = /location(?:\.href)?\s*=\s*['"][^'"]*(?:login|signin|sign-in)/i

export function parseXjx(text: string, contentType = ''): XjxCmd[] {
  const t = text.trim()
  if (t.startsWith('<') || /text\/html/i.test(contentType)) {
    throw new WebSessionExpired('the server answered with an HTML page instead of xajax JSON (logged out or blocked)')
  }
  let j: unknown
  try {
    j = JSON.parse(t)
  } catch {
    throw new WebSessionExpired(`unexpected non-JSON response (${t.slice(0, 60).replace(/\s+/g, ' ')}...)`)
  }
  const cmds = (j as { xjxobj?: unknown })?.xjxobj
  if (!Array.isArray(cmds)) throw new WebError('response has no xjxobj command list')
  for (const c of cmds as XjxCmd[]) {
    const s = typeof c.data === 'string' ? c.data : c.cmd === 'jc' ? JSON.stringify(c.data) : ''
    if ((c.cmd === 'js' || c.cmd === 'jc') && LOGIN_JS.test(s)) {
      throw new WebSessionExpired('the server redirected to the login page')
    }
  }
  return cmds as XjxCmd[]
}

export const jc = (cmds: XjxCmd[], func: string): unknown[] | undefined =>
  (cmds.find((c) => c.cmd === 'jc' && c.func === func)?.data as unknown[] | undefined) ?? undefined

export const jcAll = (cmds: XjxCmd[], func: string): unknown[][] =>
  cmds.filter((c) => c.cmd === 'jc' && c.func === func).map((c) => c.data as unknown[])

export function assigned(cmds: XjxCmd[], id?: string | RegExp): string | undefined {
  const c = cmds.find(
    (c) => c.cmd === 'as' && (id === undefined || (typeof id === 'string' ? c.id === id : id.test(String(c.id)))),
  )
  return typeof c?.data === 'string' ? c.data : undefined
}

export const scripts = (cmds: XjxCmd[]): string[] =>
  cmds.filter((c) => c.cmd === 'js' && typeof c.data === 'string').map((c) => c.data as string)

// Reads one JSON value (object/array) starting at s[start], respecting strings.
export function readJsonAt(s: string, start: number): unknown {
  const open = s[start]
  if (open !== '{' && open !== '[') throw new Error('expected { or [')
  let depth = 0
  let inStr = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return JSON.parse(s.slice(start, i + 1))
    }
  }
  throw new Error('unterminated JSON value')
}

function jsonAfter(s: string, marker: RegExp): unknown {
  const m = marker.exec(s)
  if (!m) return undefined
  const start = m.index + m[0].length
  return readJsonAt(s, start + (s.slice(start).match(/^\s*/)?.[0].length ?? 0))
}

export function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

export const htmlText = (s: string): string =>
  decodeHtml(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

// ---------------------------------------------------------------------------
// Extractors

export type RawRule = Record<string, any> & {
  id?: string
  rule_type: string | number
  actions: Record<string, any>[]
  conditions: Record<string, any>[]
}

// fill_dialog('rule_dialog', ...) → js command containing `var rule={...};`
export function extractRule(cmds: XjxCmd[]): RawRule | undefined {
  for (const js of scripts(cmds)) {
    const r = jsonAfter(js, /(?:^|[\s;])var rule\s*=/)
    if (r) return r as RawRule
  }
  return undefined
}

export function notifications(cmds: XjxCmd[]): string[] {
  return jcAll(cmds, 'create_bottom_notification').map((d) => String(d[0] ?? ''))
}

// save_rule → create_bottom_notification ["Rule <a ... onclick=\"edit_rule(123,'rule_created_toast')\">…"]
export function extractToastId(cmds: XjxCmd[]): string | undefined {
  for (const n of notifications(cmds)) {
    const m = n.match(/edit_rule\((\d+)/)
    if (m) return m[1]
  }
  return undefined
}

export function alerts(cmds: XjxCmd[]): string[] {
  return jcAll(cmds, 'xalert').map((d) => htmlText(String(d[0] ?? '')))
}

export interface ActiveHighlighterTerm {
  term: string
  case_sensitive: string | number
  id: string
  org_id?: number
  color_id?: string
}

// save/toggle_highlighter → js `highlighters=[{term,case_sensitive,id,org_id,color_id},...]`.
// `id` is the spotlight id (one entry per term of every active spotlight).
export function extractHighlighters(cmds: XjxCmd[]): ActiveHighlighterTerm[] | undefined {
  for (const js of scripts(cmds)) {
    const v = jsonAfter(js, /(?:^|[\s;])highlighters\s*=/)
    if (Array.isArray(v)) return v as ActiveHighlighterTerm[]
  }
  return undefined
}

export interface Autocomplete {
  subscriptions: { id: string; rss_url: string; url: string; type: string; title: string; feed_id: string }[]
  folders: { id: string; title: string }[]
  rules?: unknown[]
}

export function extractAutocomplete(cmds: XjxCmd[]): Autocomplete | undefined {
  const d = jc(cmds, 'autocomplete')
  return d?.find((x) => x && typeof x === 'object' && 'subscriptions' in (x as object)) as Autocomplete | undefined
}

export interface RuleCopyItem {
  id: string
  name: string
  filter_id: string
  filter_type: string
  rule_type: string
}

export function extractRuleCopyList(cmds: XjxCmd[]): RuleCopyItem[] | undefined {
  const d = jc(cmds, 'build_rule_copy_select')
  return d?.find(Array.isArray) as RuleCopyItem[] | undefined
}

export interface ListRow {
  id: string
  attrs: Record<string, string>
  checked: boolean
  html: string
}

// Rows of print_rules / print_highlighters: <div class="preferences_rules_row ..." id="preferences_rules_row_<ID>" data-sort-field-*="...">
export function parseListRows(html: string): ListRow[] {
  const s = html.replace(/\s+/g, ' ')
  const re = /<div class="preferences_rules_row(?: [^"]*)?"([^>]*)>/g
  const starts: { index: number; attrs: string }[] = []
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (/id="preferences_rules_row_\d+"/.test(m[1])) starts.push({ index: m.index, attrs: m[1] })
  }
  return starts.map((st, k) => {
    const chunk = s.slice(st.index, k + 1 < starts.length ? starts[k + 1].index : s.length)
    const attrs: Record<string, string> = {}
    for (const a of st.attrs.matchAll(/data-sort-field-([\w-]+)="([^"]*)"/g)) attrs[a[1]] = decodeHtml(a[2])
    const id = st.attrs.match(/id="preferences_rules_row_(\d+)"/)![1]
    // The row's own on/off switch; bulk-select checkboxes use a different class.
    const checked = /<input[^>]*class="apple-switch"[^>]*\bchecked\b/.test(chunk)
    return { id, attrs, checked, html: chunk }
  })
}

export interface RuleRow {
  id: string
  name: string
  enabled: boolean
  matches: number | null
  context: string | null
  ruleType: number | null
  trigger: string | null
  subtitle: string | null
  source: { kind: string; id: string } | null
}

export function parseRuleRows(html: string): RuleRow[] {
  return parseListRows(html).map((r) => {
    const h = r.html
    const del = h.match(/delete_rule\('?(\d+)'?,\s*'(\w+)',\s*(\d+)/)
    const shown = h.match(/rule_log_dialog[^>]*>\s*(\d+)\s*</)
    const trig = h.match(/<div class="flex">\s*([^<]+?)\s*<p class="text-xs text-muted-color/)
    const sub = h.match(/<p class="text-xs text-muted-color[^"]*"[^>]*>([^<]*)<\/p>/)
    const src = h.match(/view_tree_element\('(\w+)',\s*'?(\d+)/)
    const status = r.attrs.status
    return {
      id: r.id,
      name: r.attrs.name ?? htmlText(h.match(/rule-name-field[^>]*>([^<]*)</)?.[1] ?? ''),
      enabled: status !== undefined ? status === '1' : r.checked,
      matches: shown ? Number(shown[1]) : r.attrs.matches !== undefined ? Number(r.attrs.matches) : null,
      context: del ? del[2] : null,
      ruleType: del ? Number(del[3]) : null,
      trigger: trig ? decodeHtml(trig[1]) : null,
      subtitle: sub && sub[1].trim() ? decodeHtml(sub[1].trim()) : null,
      source: src ? { kind: src[1], id: src[2] } : null,
    }
  })
}

export interface SpotlightRow {
  id: string
  name: string
  color: number | null
  enabled: boolean
  createdAt: string | null
}

export function parseSpotlightRows(html: string): SpotlightRow[] {
  return parseListRows(html).map((r) => ({
    id: r.id,
    name: r.attrs.name ?? '',
    color: r.attrs.color ? Number(r.attrs.color) : null,
    enabled: r.attrs.status !== undefined ? r.attrs.status === '1' : r.checked,
    createdAt: r.attrs.date ? new Date(Number(r.attrs.date) * 1000).toISOString() : null,
  }))
}

// get_rule_tags → <select name="action_params[]"><option value="new">Add tag</option><option value="ID">name</option>...
export function parseTagOptions(html: string): { id: string; name: string; selected: boolean }[] {
  return [...html.matchAll(/<option value="([^"]*)"\s*(selected)?\s*>([^<]*)<\/option>/g)]
    .filter((m) => m[1] !== 'new' && m[1] !== '')
    .map((m) => ({ id: m[1], name: decodeHtml(m[3]).trim(), selected: !!m[2] }))
}

export interface SpotlightDialog {
  description: string
  color: number | null
  team: boolean
  terms: { id: string; term: string; caseSensitive: boolean }[]
}

// fill_dialog('highlighter_dialog', {id, inline:true}) → form HTML + one jc add_highlighter_term per term.
export function parseSpotlightDialog(cmds: XjxCmd[]): SpotlightDialog {
  const html = (assigned(cmds) ?? '').replace(/\s+/g, ' ')
  const desc = html.match(/<input[^>]*id="highlighter_description"[^>]*>/)?.[0].match(/value="([^"]*)"/)?.[1] ?? ''
  const color = html.match(/<input[^>]*id="hl_color_id_[^"]*"[^>]*>/)?.[0].match(/value="(\d+)"/)?.[1]
  const teamInput = html.match(/<input[^>]*id="highlighter_team_members_[^"]*"[^>]*>/)?.[0] ?? ''
  const terms = jcAll(cmds, 'add_highlighter_term')
    .map((d) => d[1] as { id: string | number; term: string; case_sensitive: string | number })
    .filter((t) => t && t.term !== '')
    .map((t) => ({ id: String(t.id), term: t.term, caseSensitive: String(t.case_sensitive) === '1' }))
  return {
    description: decodeHtml(desc),
    color: color ? Number(color) : null,
    team: /\bchecked\b/.test(teamInput),
    terms,
  }
}

export interface RunResult {
  totalArticles: number | null
  matchedArticles: number | null
  seconds: number | null
  message: string
}

export function parseRunResult(cmds: XjxCmd[]): RunResult | undefined {
  const text = alerts(cmds)[0]
  if (!text) return undefined
  const num = (re: RegExp) => {
    const m = text.match(re)
    return m ? Number(m[1].replace(/,/g, '')) : null
  }
  return {
    totalArticles: num(/Total articles:\s*([\d,.]+)/),
    matchedArticles: num(/Matched articles:\s*([\d,.]+)/),
    seconds: num(/Processing time:\s*([\d.]+)/),
    message: text,
  }
}

// The page bootstrap (`var preference_sections = {...}`) lists preference checkboxes;
// returns the items of one section, e.g. "emails_from_inoreader".
export function extractPreferenceItems(pageHtml: string, section: string): Record<string, any>[] | undefined {
  const key = `"${section}":`
  const at = pageHtml.indexOf(key)
  if (at < 0) return undefined
  let i = at + key.length
  while (/\s/.test(pageHtml[i])) i++
  const obj = readJsonAt(pageHtml, i) as { items?: Record<string, any>[] }
  return obj.items
}

// ---------------------------------------------------------------------------
// Session

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let lastCallAt = 0

export interface WebSessionOptions {
  dryRun?: boolean
  delayMs?: number
  fetch?: typeof fetch
  credentials?: WebCredentials
}

export class WebSession {
  readonly dryRun: boolean
  readonly planned: WebCall[] = []
  private creds: WebCredentials | undefined
  private loaded = false
  private readonly delayMs: number
  private readonly doFetch: typeof fetch

  constructor(opts: WebSessionOptions = {}) {
    this.dryRun = !!opts.dryRun
    this.delayMs = opts.delayMs ?? Number(process.env.INOREADER_WEB_DELAY_MS ?? 750)
    this.doFetch = opts.fetch ?? fetch
    if (opts.credentials) {
      this.creds = opts.credentials
      this.loaded = true
    }
  }

  private credentials(): WebCredentials {
    if (!this.loaded) {
      this.creds = loadWebCredentials()
      this.loaded = true
    }
    if (!this.creds?.cookie) throw new WebSessionExpired('no web session stored')
    return this.creds
  }

  // Polite pacing: at least delayMs between requests within this process.
  private async throttle(): Promise<void> {
    const wait = lastCallAt + this.delayMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastCallAt = Date.now()
  }

  private headers(referer: string, extra: Record<string, string> = {}): Record<string, string> {
    const c = this.credentials()
    return {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      origin: ORIGIN,
      referer: `${ORIGIN}${referer.startsWith('/') ? referer : `/${referer}`}`,
      'user-agent': c.userAgent || DEFAULT_USER_AGENT,
      cookie: c.cookie,
      ...extra,
    }
  }

  // Read-only call: always sent, even in dry-run mode.
  async read(fn: string, args: unknown[] = [], referer = '/'): Promise<XjxCmd[]> {
    return this.send(fn, args, referer)
  }

  // State-changing call: recorded instead of sent in dry-run mode (returns []).
  async write(fn: string, args: unknown[] = [], referer = '/'): Promise<XjxCmd[]> {
    if (this.dryRun) {
      this.planned.push({ fn, args, referer })
      return []
    }
    return this.send(fn, args, referer)
  }

  private async send(fn: string, args: unknown[], referer: string): Promise<XjxCmd[]> {
    const headers = this.headers(referer, { 'content-type': 'application/x-www-form-urlencoded' })
    await this.throttle()
    const res = await this.doFetch(`${ORIGIN}/?xjxfun=${encodeURIComponent(fn)}`, {
      method: 'POST',
      headers,
      body: encodeBody(fn, args),
      redirect: 'manual',
    })
    const text = await res.text()
    checkStatus(res.status, res.headers.get('location'))
    return parseXjx(text, res.headers.get('content-type') ?? '')
  }

  // GET an HTML page of the web app (used only where no xajax read exists).
  async page(path: string): Promise<string> {
    const headers = this.headers(path, { accept: 'text/html' })
    delete (headers as Record<string, string | undefined>).origin
    await this.throttle()
    const res = await this.doFetch(`${ORIGIN}${path}`, { headers, redirect: 'manual' })
    const text = await res.text()
    checkStatus(res.status, res.headers.get('location'))
    if (!/xajax\.config/.test(text)) throw new WebSessionExpired('the page did not load the web app (logged out?)')
    return text
  }
}

function checkStatus(status: number, location: string | null): void {
  if (status >= 300 && status < 400) {
    throw new WebSessionExpired(`redirected${location ? ` to ${location.replace(/\?.*/, '')}` : ''}`)
  }
  if (status === 401 || status === 403) throw new WebSessionExpired(`HTTP ${status} (logged out, or blocked by Cloudflare)`)
  if (status >= 400) throw new WebError(`HTTP ${status}`)
}

// Cheap authenticated read used by `web login` / `web status`: the tag picker of the
// rule editor (~1 KB). A logged-in session returns a <select>; anything else fails.
export async function probe(session: WebSession): Promise<{ tags: number }> {
  const cmds = await session.read('get_rule_tags', ['tags_probe', null], '/rules')
  const html = assigned(cmds, 'tags_probe')
  if (!html || !/<select/i.test(html)) throw new WebSessionExpired('session check failed (no tag list returned)')
  return { tags: parseTagOptions(html).length }
}
