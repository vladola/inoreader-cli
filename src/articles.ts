// Articles as the web app sees them (print_articles / search / single article), parsed
// into the same compact shape the API path prints.
//
// Article ids — three forms of the same article (verified against live data):
//   API item id  tag:google.com,2005:reader/item/0000000ba43b7400   (16 hex digits)
//   web "aid"    50000000000                                        (data-aid, article_<aid>)
//                -> aid is simply the API item id's hex read as a number.
//   web "oid"    16 hex digits     (data-oid; the /article/<oid>-<slug> share links)
//                -> oid = aid XOR K for a fixed 64-bit K. K is not hard-coded here: it is
//                   learned from any listed article (aid ^ oid) and cached locally.

import type { XjxCmd } from './web.ts'
import { decodeEntities, elementInner, htmlToText } from './text.ts'

export const API_ITEM_PREFIX = 'tag:google.com,2005:reader/item/'

export function aidFromApiId(id: string): string {
  const hex = id.startsWith(API_ITEM_PREFIX) ? id.slice(API_ITEM_PREFIX.length) : id
  if (!/^[0-9a-f]{1,16}$/i.test(hex)) throw new Error(`not an API item id: ${id}`)
  return BigInt(`0x${hex}`).toString(10)
}

export function apiIdFromAid(aid: string | number): string {
  return API_ITEM_PREFIX + BigInt(aid).toString(16).padStart(16, '0')
}

export function oidFromAid(aid: string | number, key: string): string {
  return (BigInt(aid) ^ BigInt(`0x${key}`)).toString(16).padStart(16, '0')
}

export function aidFromOid(oid: string, key: string): string {
  return (BigInt(`0x${oid}`) ^ BigInt(`0x${key}`)).toString(10)
}

export function oidKeyOf(aid: string, oid: string): string {
  return (BigInt(aid) ^ BigInt(`0x${oid}`)).toString(16).padStart(16, '0')
}

export type ArticleRef = { kind: 'aid'; aid: string } | { kind: 'oid'; oid: string }

// Accepts: API long id, web aid (decimal), an inoreader.com/article/<oid>[-slug] link, or a
// bare 16-hex value. Zero-padded hex (API ids are small numbers) is read as an API id,
// anything else 16-hex as an oid.
export function parseArticleRef(s: string): ArticleRef {
  const t = s.trim()
  const link = t.match(/inoreader\.com\/article\/([0-9a-f]{16})/i)
  if (link) return { kind: 'oid', oid: link[1].toLowerCase() }
  if (t.startsWith(API_ITEM_PREFIX)) return { kind: 'aid', aid: aidFromApiId(t) }
  if (/^\d+$/.test(t)) return { kind: 'aid', aid: String(BigInt(t)) }
  if (/^[0-9a-f]{16}$/i.test(t)) return /^0000/.test(t) ? { kind: 'aid', aid: aidFromApiId(t) } : { kind: 'oid', oid: t.toLowerCase() }
  throw new Error(`unrecognised article id: ${s}`)
}

// ---------------------------------------------------------------------------

export interface WebArticle {
  id: string
  aid: string
  oid: string
  title: string
  url?: string
  source?: string
  sourceId?: string
  published: string
  author?: string
  read: boolean
  starred: boolean
  tags: string[]
  // Only in web output: needed to rewrite an article's tag set with save_tags.
  tagIds: Record<string, string>
  sunk: boolean
  mobilized: boolean
  feedType?: string
  contentHtml?: string
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Like a browser, the first occurrence of a repeated attribute wins.
  for (const m of tag.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] ??= decodeEntities(m[2] ?? m[3] ?? '')
  return out
}

function jsonAttr(v: string | undefined): Record<string, string> {
  if (!v || v === 'null') return {}
  try {
    const o = JSON.parse(v)
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

// The content map of print_articles (articles_loaded) or of a single article.
export function contentMap(cmds: XjxCmd[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of cmds) {
    if (c.cmd !== 'jc' || (c.func !== 'articles_loaded' && c.func !== 'single_article_loaded')) continue
    const m = (c.data as unknown[])[0]
    if (m && typeof m === 'object') for (const [k, v] of Object.entries(m)) if (typeof v === 'string') out[k] = v
  }
  return out
}

function byId(html: string, id: string): string | undefined {
  const at = html.indexOf(`id="${id}"`)
  if (at < 0) return undefined
  const start = html.lastIndexOf('<', at)
  return start < 0 ? undefined : elementInner(html, start)
}

function anchor(html: string, id: string): { href?: string; text: string } | undefined {
  const m = html.match(new RegExp(`<a\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</a>`))
  if (!m) return undefined
  return { href: m[0].match(/\bhref="([^"]*)"/)?.[1], text: htmlToText(m[1].replace(/<wbr\s*\/?>/gi, '')) }
}

export function parseArticles(cmds: XjxCmd[]): WebArticle[] {
  const contents = contentMap(cmds)
  const seen = new Set<string>()
  const out: WebArticle[] = []
  for (const c of cmds) {
    // Page 1 assigns the list (`as`); later pages append to it (`ap`).
    if ((c.cmd !== 'as' && c.cmd !== 'ap') || typeof c.data !== 'string' || !c.data.includes('id="article_')) continue
    const html = c.data
    const starts = [...html.matchAll(/<div id="article_(\d+)"[^>]*>/g)]
    starts.forEach((m, i) => {
      const aid = m[1]
      if (seen.has(aid)) return
      const a = attrs(m[0])
      if (!a['data-aid']) return
      seen.add(aid)
      const chunk = html.slice(m.index, i + 1 < starts.length ? starts[i + 1].index : undefined)
      const body = contents[aid] ?? ''
      const titleA =
        anchor(body, `article_title_link_${aid}`) ?? anchor(chunk, `aurl_${aid}`) ?? anchor(chunk, `burl_${aid}`)
      const titleText =
        titleA?.text ||
        htmlToText(chunk.match(new RegExp(`id="article_title_link_inline_${aid}"[^>]*>([\\s\\S]*?)</span>`))?.[1] ?? '')
      const feed = anchor(body, `article_feed_info_link_${aid}`)
      const feedName = feed?.text || htmlToText(chunk.match(/class="[^"]*article_feed_title[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|a)>/)?.[1] ?? '')
      const author = body.match(new RegExp(`class=['"]article-author-${aid}['"][^>]*>([\\s\\S]*?)</span>`))?.[1]
      const usec = Number(a['data-date_usec'] || 0)
      const secs = usec ? Math.floor(usec / 1e6) : Number(a['data-date_rel'] || 0)
      const tagIds = { ...jsonAttr(a['data-mtags']), ...jsonAttr(a['data-atags']) }
      const contentHtml = byId(body, `article_contents_inner_${aid}`)
      out.push({
        id: apiIdFromAid(aid),
        aid,
        oid: a['data-oid'] ?? '',
        title: titleText,
        url: titleA?.href ? decodeEntities(titleA.href) : undefined,
        source: feedName || undefined,
        sourceId: feed?.href?.startsWith('/feed/') ? `feed/${decodeURIComponent(feed.href.slice(6))}` : undefined,
        published: new Date(secs * 1000).toISOString(),
        author: author ? htmlToText(author) || undefined : undefined,
        read: a['data-read'] === '1',
        starred: a['data-fav'] === '1',
        tags: [...new Set(Object.values(tagIds))],
        tagIds,
        sunk: a['data-sunk'] === '1',
        mobilized: a['data-mobilized'] === '1',
        feedType: a['data-ft'] || undefined,
        contentHtml,
      })
    })
  }
  return out
}

// Paging state print_articles hands back. set_seen_ids is cumulative, so the next page is
// print_articles(false, <latest seen ids>, {...feed_params, ...next}); it arrives as `ap`.
export interface Paging {
  ids: string[]
  hasMore: boolean
  next: Record<string, unknown>
}

export function parsePaging(cmds: XjxCmd[]): Paging {
  const seen = cmds.find((c) => c.cmd === 'jc' && c.func === 'set_seen_ids')?.data as unknown[] | undefined
  const ids = Array.isArray(seen?.[0]) ? (seen![0] as unknown[]).map(String) : []
  const loaded = cmds.find((c) => c.cmd === 'jc' && c.func === 'articles_loaded')?.data as unknown[] | undefined
  const next: Record<string, unknown> = {}
  if (loaded) {
    const [, loadDate, , lastFeedId, lastArticleDate, noUnreadChecked, currentFeedIds, firstArticleDate, , , filteredFeeds] = loaded
    if (loadDate) next.last_load_date = loadDate
    if (lastFeedId) next.last_feed_id = lastFeedId
    if (lastArticleDate) next.last_article_date = lastArticleDate
    if (firstArticleDate) next.first_article_date = firstArticleDate
    if (noUnreadChecked) next.no_unread_checked = noUnreadChecked
    if (currentFeedIds) next.current_feed_ids = currentFeedIds
    if (filteredFeeds) next.filtered_feeds = filteredFeeds
  }
  const hasMore = cmds.some((c) => (c.cmd === 'as' || c.cmd === 'ap') && typeof c.data === 'string' && c.data.includes('id="next_articles"'))
  return { ids, hasMore, next }
}

// mobilize(aid, 0|1, ...) -> jc mobilize_callback [aid, html, ...] or mobilize_callback_error.
export function parseMobilize(cmds: XjxCmd[]): { html?: string; error?: string } {
  for (const c of cmds) {
    if (c.cmd !== 'jc') continue
    const d = c.data as unknown[]
    if (c.func === 'mobilize_callback' && typeof d?.[1] === 'string') return { html: d[1] }
    if (c.func === 'mobilize_callback_error') return { error: htmlToText(String(d?.[1] ?? d?.[0] ?? 'full content not available')) }
  }
  return { error: 'no full content returned' }
}

// Newsletter items (user_newsletter feeds, @ino.to addresses) already carry the whole email.
export function isNewsletter(a: { feedType?: string; sourceId?: string; url?: string }): boolean {
  return a.feedType === 'user_newsletter' || /@ino\.to$/i.test(a.sourceId ?? '')
}
