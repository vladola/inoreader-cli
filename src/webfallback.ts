// Article commands over the web session: `--via web`, the automatic fallback when the API
// budget is exhausted, and `search` (web only). Output matches the API path's JSON.

import { loadArticles, saveArticles, type CachedArticle } from './cache.ts'
import { type WebArticle } from './articles.ts'
import { htmlToText } from './text.ts'
import { WebSession } from './web.ts'
import { editTag, fullContent, getArticle, listStream, search, setRead, setStar, toAid } from './webreader.ts'

type Opts = Record<string, any>

const CACHE_TEXT_CHARS = Number(process.env.INOREADER_CACHE_TEXT_CHARS ?? 4000)

export function compactWeb(a: WebArticle, content?: 'text' | 'html'): CachedArticle & { content?: string } {
  const out: CachedArticle & { content?: string } = {
    id: a.id,
    title: a.title,
    url: a.url,
    source: a.source,
    sourceId: a.sourceId,
    published: a.published,
    author: a.author,
    read: a.read,
    starred: a.starred,
    tags: a.tags,
  }
  if (content) out.content = content === 'html' ? a.contentHtml : htmlToText(a.contentHtml ?? '')
  return out
}

async function withFullContent(s: WebSession, a: WebArticle, html: boolean) {
  const fc = await fullContent(
    { aid: a.aid, url: a.url, html: a.contentHtml, sourceId: a.sourceId, feedType: a.feedType, mobilized: a.mobilized },
    s,
  )
  const base = compactWeb(a)
  return {
    ...base,
    content: html && fc.html ? fc.html : fc.text,
    contentSource: fc.contentSource,
    ...(fc.note ? { contentNote: fc.note } : {}),
  }
}

export async function readIds(ids: string[]): Promise<string[]> {
  if (!ids.includes('-')) return ids
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const fromStdin = input.split(/\s+/).filter(Boolean)
  return [...new Set(ids.flatMap((i) => (i === '-' ? fromStdin : [i])))]
}

function need(args: string[], n: number, what: string): void {
  if (args.length < n) throw new Error(`usage: ${what}`)
}

// Mirror web writes into the cache, like the API path does.
function mirror(aids: Set<string>, apply: (a: CachedArticle) => void): void {
  const cache = loadArticles()
  let touched = false
  for (const art of cache.values()) {
    const hex = art.id.split('/').pop() ?? ''
    if (/^[0-9a-f]{16}$/i.test(hex) && aids.has(BigInt(`0x${hex}`).toString(10))) {
      apply(art)
      touched = true
    }
  }
  if (touched) saveArticles(cache)
}

export async function webArticles(cmd: string, args: string[], o: Opts, parseSince: (s: string) => number): Promise<unknown> {
  const s = new WebSession({ dryRun: !!o['dry-run'] })
  const since = o.since ? parseSince(o.since) : undefined
  const contentMode = o.html ? 'html' : o.full ? 'text' : undefined

  switch (cmd) {
    case 'list': {
      if (o.continuation) throw new Error('--continuation is an API token; not supported with --via web')
      const { items, calls } = await listStream(s, args[0] ?? 'all', {
        limit: Number(o.limit ?? 20),
        unread: !!o.unread,
        since,
        oldest: !!o.oldest,
      })
      const re = o.grep ? new RegExp(o.grep, 'i') : undefined
      const kept = items.filter((a) => !re || re.test(`${a.title} ${a.source}`))
      const rendered = []
      for (const a of kept) rendered.push(o['full-content'] ? await withFullContent(s, a, !!o.html) : compactWeb(a, contentMode))
      return { items: rendered, via: 'web', webCalls: calls }
    }

    case 'search': {
      need(args, 1, 'search "TERM" [--limit N] [--stream S] [--since ..] [--match all|any|phrase|advanced] [--in all|title|content] [--order newest|oldest|relevance]')
      const { items, calls } = await search(s, args.join(' '), {
        limit: Number(o.limit ?? 20),
        stream: o.stream,
        since,
        match: o.match,
        in: o.in,
        order: o.order,
        language: o.language,
        unread: !!o.unread,
      })
      const rendered = []
      for (const a of items) rendered.push(o['full-content'] ? await withFullContent(s, a, !!o.html) : compactWeb(a, contentMode))
      return { items: rendered, webCalls: calls }
    }

    case 'sync': {
      if (o.continuation) throw new Error('--continuation is an API token; not supported with --via web')
      const cache = loadArticles()
      const known = new Set(cache.keys())
      const pages = Number(o.pages ?? 3)
      const { items, calls } = await listStream(s, args[0] ?? 'all', {
        limit: pages * 100,
        unread: !!o.unread,
        since,
        // Newest-first: a page with nothing new means we've caught up.
        stopWhen: (page) => !o.deep && page.length > 0 && page.every((a) => known.has(a.id)),
      })
      let added = 0
      for (const a of items) {
        if (!known.has(a.id)) added++
        const { content, ...rest } = compactWeb(a, 'text')
        cache.set(a.id, { ...rest, text: content?.slice(0, CACHE_TEXT_CHARS) })
      }
      saveArticles(cache)
      return { stream: args[0] ?? 'all', via: 'web', webCalls: calls, fetched: items.length, new: added, cached: cache.size }
    }

    case 'get': {
      need(args, 1, 'get ID...')
      const out = []
      for (const ref of await readIds(args)) {
        const a = await getArticle(s, ref)
        if (!a) {
          out.push({ id: ref, error: 'not found' })
          continue
        }
        out.push(o['full-content'] ? await withFullContent(s, a, !!o.html) : compactWeb(a, o.html ? 'html' : 'text'))
      }
      return out
    }

    case 'read':
    case 'unread': {
      need(args, 1, `${cmd} ID...`)
      const aids = []
      for (const r of await readIds(args)) aids.push(await toAid(s, r))
      const calls = await setRead(s, aids, cmd === 'read')
      if (s.dryRun) return { dryRun: true, calls: s.planned }
      mirror(new Set(aids), (a) => (a.read = cmd === 'read'))
      return {
        ok: true,
        via: 'web',
        count: aids.length,
        calls,
        ...(cmd === 'unread' ? { note: 'articles older than 30 days stay read (Inoreader "sinks" them)' } : {}),
      }
    }

    case 'star':
    case 'unstar': {
      need(args, 1, `${cmd} ID...`)
      const aids = []
      for (const r of await readIds(args)) aids.push(await toAid(s, r))
      const calls = await setStar(s, aids, cmd === 'star')
      if (s.dryRun) return { dryRun: true, calls: s.planned }
      mirror(new Set(aids), (a) => (a.starred = cmd === 'star'))
      return { ok: true, via: 'web', count: aids.length, calls }
    }

    case 'tag':
    case 'untag': {
      need(args, 2, `${cmd} NAME ID...`)
      const name = args[0].replace(/^user\/[^/]+\/label\//, '')
      const refs = await readIds(args.slice(1))
      const r = await editTag(s, refs, name, cmd === 'tag')
      if (s.dryRun) return { dryRun: true, calls: s.planned }
      const aids = new Set<string>()
      for (const ref of refs) aids.add(await toAid(s, ref))
      mirror(aids, (a) => {
        a.tags = cmd === 'tag' ? [...new Set([...a.tags, name])] : a.tags.filter((t) => t !== name)
      })
      return { ok: true, via: 'web', count: refs.length, changed: r.changed, calls: r.calls }
    }

    default:
      throw new Error(`command ${cmd} has no web implementation`)
  }
}

export const WEB_ARTICLE_COMMANDS = new Set(['list', 'sync', 'get', 'read', 'unread', 'star', 'unstar', 'tag', 'untag'])
export const READ_COMMANDS = new Set(['list', 'sync', 'get'])
