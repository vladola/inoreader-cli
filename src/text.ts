// HTML -> text helpers shared by the API and web paths, plus the heuristics behind
// `--full-content` (is this body truncated? what is the main text of a web page?).

const NAMED_ENTITIES: Record<string, string> = {
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&([a-z]+);/g, (m, n: string) => NAMED_ENTITIES[n] ?? m)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|pre|section|article|figure)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Signs that a feed only carries an excerpt. Deliberately simple: short bodies, or
// bodies that end in an ellipsis / "read more" style link.
export const TRUNCATED_MIN_CHARS = Number(process.env.INOREADER_FULL_MIN_CHARS ?? 1500)
const TRUNCATION_TAIL =
  /(…|\.\.\.|\[…\]|\[\.\.\.\]|\(…\)|read more|continue reading|read the (full|rest)|keep reading|full (article|story|post)|the post .{1,200} appeared first on .{1,120})\W*$/i

export function looksTruncated(text: string | undefined): boolean {
  const t = (text ?? '').trim()
  if (t.length < TRUNCATED_MIN_CHARS) return true
  return TRUNCATION_TAIL.test(t.slice(-300))
}

// ---------------------------------------------------------------------------
// Minimal readability: pick <article>/<main>/common content containers, else the
// element with the most paragraph text. Good enough for blogs and news sites.

const CANDIDATE =
  /<(article|main)\b[^>]*>|<(div|section)\b[^>]*(?:class|id)="[^"]*\b(post-content|entry-content|article-body|article__body|article-content|story-body|post-body|content-body|markdown-body|prose)\b[^"]*"[^>]*>/gi

// Inner HTML of the element whose opening tag starts at `start` (tag-balanced).
export function elementInner(html: string, start: number): string | undefined {
  const open = html.slice(start).match(/^<([a-z0-9]+)\b[^>]*>/i)
  if (!open) return undefined
  const tag = open[1].toLowerCase()
  const re = new RegExp(`<(/?)${tag}\\b[^>]*?(/?)>`, 'gi')
  re.lastIndex = start + open[0].length
  let depth = 1
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[2]) continue // self-closing
    depth += m[1] ? -1 : 1
    if (depth === 0) return html.slice(start + open[0].length, m.index)
  }
  return html.slice(start + open[0].length)
}

function paragraphScore(html: string): number {
  let n = 0
  for (const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) n += htmlToText(m[1]).length
  return n
}

export function extractMainText(pageHtml: string): { title?: string; text: string } {
  const html = pageHtml.replace(/<(script|style|noscript|template|svg|nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, '')
  const title =
    pageHtml.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i)?.[1] ??
    pageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  let best = ''
  let bestScore = 0
  for (const m of html.matchAll(CANDIDATE)) {
    const inner = elementInner(html, m.index)
    if (!inner) continue
    const score = paragraphScore(inner)
    if (score > bestScore) {
      best = inner
      bestScore = score
    }
  }
  if (bestScore < 200) {
    // Fallback: the <div>/<section>/<td> whose direct paragraphs hold the most text.
    for (const m of html.matchAll(/<(div|section|td)\b[^>]*>/gi)) {
      const inner = elementInner(html, m.index)
      if (!inner || inner.length > 400_000) continue
      const score = paragraphScore(inner.replace(/<(div|section)\b[\s\S]*?<\/\1>/gi, ''))
      if (score > bestScore) {
        best = inner
        bestScore = score
      }
    }
  }
  const text = htmlToText(bestScore ? best : (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html))
  return { title: title ? htmlToText(title) : undefined, text }
}
