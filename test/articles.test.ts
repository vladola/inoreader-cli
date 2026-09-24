// Article parsing, id conversion, full-content heuristics. Synthetic fixtures only.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  aidFromApiId,
  aidFromOid,
  apiIdFromAid,
  isNewsletter,
  oidFromAid,
  oidKeyOf,
  parseArticleRef,
  parseArticles,
  parseMobilize,
  parsePaging,
} from '../src/articles.ts'
import { elementInner, extractMainText, htmlToText, looksTruncated } from '../src/text.ts'
import type { XjxCmd } from '../src/web.ts'
import { WebSession } from '../src/web.ts'
import { acceptable, fullContent, searchRange, streamParams } from '../src/webreader.ts'

// A made-up XOR key; the real one is learned at runtime and never stored in the repo.
const KEY = '1234abcd00ff00ff'

test('id conversion: API hex <-> aid <-> oid', () => {
  assert.equal(aidFromApiId('tag:google.com,2005:reader/item/00000000000003e9'), '1001')
  assert.equal(aidFromApiId('3e9'), '1001')
  assert.equal(apiIdFromAid('1001'), 'tag:google.com,2005:reader/item/00000000000003e9')
  assert.equal(apiIdFromAid(50000000000), 'tag:google.com,2005:reader/item/0000000ba43b7400')
  const oid = oidFromAid('50000000000', KEY)
  assert.equal(oid.length, 16)
  assert.equal(aidFromOid(oid, KEY), '50000000000')
  assert.equal(oidKeyOf('50000000000', oid), KEY)
  assert.throws(() => aidFromApiId('tag:google.com,2005:reader/item/xyz'))
})

test('parseArticleRef: every accepted id form', () => {
  assert.deepEqual(parseArticleRef('tag:google.com,2005:reader/item/00000000000003e9'), { kind: 'aid', aid: '1001' })
  assert.deepEqual(parseArticleRef('1001'), { kind: 'aid', aid: '1001' })
  assert.deepEqual(parseArticleRef('00000000000003e9'), { kind: 'aid', aid: '1001' })
  assert.deepEqual(parseArticleRef('https://www.inoreader.com/article/1234abcd00ff1234-some-title'), { kind: 'oid', oid: '1234abcd00ff1234' })
  assert.deepEqual(parseArticleRef('1234ABCD00FF1234'), { kind: 'oid', oid: '1234abcd00ff1234' })
  assert.throws(() => parseArticleRef('not-an-id'))
})

const div = (aid: number, extra = '', read = '0') =>
  `<div id="article_${aid}" class="ar article_unreaded" data-read="${read}" data-sunk="0" data-aid="${aid}" data-oid="${oidFromAid(aid, KEY)}" data-date_usec="1700000000123456" data-date_rel="1700000000" data-suid="2001" data-fav="1" data-tags='{"4001":"Folder A","3001":"alpha"}' data-mtags='{"3001":"alpha"}' data-atags='{"3002":"beta &amp; co"}' data-ft="rss" data-mobilized="0" ${extra}>
    <div class="article_header"><a id="aurl_${aid}" href="https://example.com/fallback">Fallback title</a></div>
  </div>`

const content = (aid: number, body: string) => `
  <div id="article_footer_placeholder_top_${aid}"></div>
  <div class="article_title mb-2"><a class="article_title_link" id="article_title_link_${aid}" target="_blank" href="https://example.com/post?a=1&amp;b=2" class="boldlink">A <mark class="hl">marked</mark> title<wbr></a></div>
  <div class="article_sub_title"><span><a dir="ltr" class="ajaxed" id="article_feed_info_link_${aid}" href="/feed/https%3A%2F%2Fexample.com%2Ffeed" title="Go to feed"> Example Feed</a></span>
  <span class="text-muted-color">by&nbsp;<span class='article-author-${aid}'><a href="mailto:x">Jane Doe </a></span></span></div>
  <div class="article_content mt-2" id="article_contents_inner_${aid}"><div><p>${body}</p><div>nested</div></div></div>
  <div class="article_footer">footer text</div>`

test('parseArticles: list page (as), appended page (ap), content map, attributes', () => {
  const cmds: XjxCmd[] = [
    { cmd: 'jc', func: 'set_seen_ids', data: [[1001, 1002]] },
    { cmd: 'as', id: 'reader_pane', prop: 'innerHTML', data: `<div class="sort-row"></div>${div(1001)}${div(1002, '', '1')}<div id="next_articles"></div>` },
    { cmd: 'jc', func: 'articles_loaded', data: [{ 1001: content(1001, 'Hello &amp; welcome'), 1002: content(1002, 'Second') }, 1.5, '2', 0, 1699990000, 0, ['9'], 1699990000.5, null, {}, false] },
  ]
  const [a, b] = parseArticles(cmds)
  assert.equal(a.id, 'tag:google.com,2005:reader/item/00000000000003e9')
  assert.equal(a.aid, '1001')
  assert.equal(a.title, 'A marked title')
  assert.equal(a.url, 'https://example.com/post?a=1&b=2')
  assert.equal(a.source, 'Example Feed')
  assert.equal(a.sourceId, 'feed/https://example.com/feed')
  assert.equal(a.author, 'Jane Doe')
  assert.equal(a.published, '2023-11-14T22:13:20.000Z')
  assert.equal(a.read, false)
  assert.equal(a.starred, true)
  assert.deepEqual(a.tags, ['alpha', 'beta & co']) // folders ("Folder A") excluded
  assert.deepEqual(a.tagIds, { 3001: 'alpha', 3002: 'beta & co' })
  assert.equal(a.feedType, 'rss')
  assert.equal(htmlToText(a.contentHtml ?? ''), 'Hello & welcome\nnested')
  assert.equal(b.read, true)

  const p = parsePaging(cmds)
  assert.deepEqual(p.ids, ['1001', '1002'])
  assert.equal(p.hasMore, true)
  assert.deepEqual(p.next, { last_load_date: 1.5, last_article_date: 1699990000, first_article_date: 1699990000.5, current_feed_ids: ['9'] })

  // Page 2 arrives as an append.
  const more = parseArticles([{ cmd: 'ap', id: 'reader_pane', prop: 'innerHTML', data: div(1003) }])
  assert.equal(more[0].aid, '1003')
  assert.equal(more[0].title, 'Fallback title') // no content map -> list markup
  assert.equal(parsePaging([{ cmd: 'ap', id: 'reader_pane', prop: 'innerHTML', data: div(1003) }]).hasMore, false)
})

test('parseArticles: single article response', () => {
  const cmds: XjxCmd[] = [
    { cmd: 'as', id: 'single_article_holster', prop: 'innerHTML', data: div(1004, 'data-ft="user_newsletter"') },
    { cmd: 'jc', func: 'single_article_loaded', data: [{ 1004: content(1004, 'Newsletter body') }] },
  ]
  const [a] = parseArticles(cmds)
  assert.equal(a.aid, '1004')
  assert.equal(a.feedType, 'rss') // the first data-ft attribute wins, like the browser
  assert.equal(isNewsletter({ sourceId: 'feed/someone@ino.to' }), true)
  assert.equal(isNewsletter({ feedType: 'user_newsletter' }), true)
  assert.equal(isNewsletter({ feedType: 'rss', sourceId: 'feed/https://example.com/feed' }), false)
})

test('parseMobilize', () => {
  assert.deepEqual(parseMobilize([{ cmd: 'jc', func: 'mobilize_done', data: [1] }, { cmd: 'jc', func: 'mobilize_callback', data: [1, '<p>Full</p>', true, []] }]), { html: '<p>Full</p>' })
  assert.ok(parseMobilize([{ cmd: 'jc', func: 'mobilize_callback_error', data: [1, 'Nope'] }]).error)
  assert.ok(parseMobilize([]).error)
})

test('htmlToText, elementInner and looksTruncated', () => {
  assert.equal(htmlToText('<p>a&nbsp;&ldquo;b&rdquo;</p><script>x()</script><ul><li>one</li></ul>'), 'a “b”\n- one')
  const html = '<div id="x"><div>in</div><p>deep</p></div><div>after</div>'
  assert.equal(elementInner(html, 0), '<div>in</div><p>deep</p>')
  assert.equal(looksTruncated('short'), true)
  assert.equal(looksTruncated(`${'word '.repeat(400)}Read more …`), true)
  assert.equal(looksTruncated(`${'word '.repeat(400)}The post Foo appeared first on Example Blog.`), true)
  assert.equal(looksTruncated(`${'word '.repeat(400)}the end.`), false)
})

test('extractMainText: <article>, content classes, largest block fallback', () => {
  const para = (s: string) => `<p>${s} ${'lorem ipsum dolor sit amet '.repeat(12)}</p>`
  const page = `<html><head><title>Page &amp; title</title></head><body>
    <nav><p>${'menu '.repeat(80)}</p></nav>
    <div class="sidebar"><p>short</p></div>
    <article>${para('First')}${para('Second')}</article>
    <footer><p>${'footer '.repeat(80)}</p></footer></body></html>`
  const r = extractMainText(page)
  assert.equal(r.title, 'Page & title')
  assert.match(r.text, /^First lorem/)
  assert.match(r.text, /Second lorem/)
  assert.doesNotMatch(r.text, /menu|footer/)
  const noArticle = `<body><div id="a"><p>tiny</p></div><div id="b">${para('Main')}${para('More')}</div></body>`
  assert.match(extractMainText(noArticle).text, /^Main lorem/)
})

test('searchRange and acceptable()', () => {
  const now = 1_700_000_000
  assert.equal(searchRange(undefined, now), '5')
  assert.equal(searchRange(now - 3600, now), '1')
  assert.equal(searchRange(now - 3 * 86400, now), '2')
  assert.equal(searchRange(now - 20 * 86400, now), '3')
  assert.equal(searchRange(now - 200 * 86400, now), '4')
  assert.equal(searchRange(now - 900 * 86400, now), '5')
  assert.equal(acceptable('x'.repeat(250), 'y'.repeat(400)), true)
  assert.equal(acceptable('x'.repeat(150), ''), false)
  assert.equal(acceptable('x'.repeat(300), 'y'.repeat(900)), false)
})

test('streamParams: streams that need no lookup', async () => {
  const s = new WebSession({ credentials: { cookie: 'a=1', userAgent: 'UA', savedAt: '' }, fetch: (() => { throw new Error('no network in tests') }) as unknown as typeof fetch })
  assert.deepEqual(await streamParams(s, 'all'), { filter_type: 'all_articles' })
  assert.deepEqual(await streamParams(s, 'starred'), { filter_type: 'starred' })
  assert.deepEqual(await streamParams(s, 'tag:alpha'), { filter_type: 'tag', filter_url: 'alpha' })
  assert.deepEqual(await streamParams(s, 'folder:Folder A'), { filter_type: 'folder', filter_url: 'Folder A' })
  assert.deepEqual(await streamParams(s, 'feed:https://example.com/feed'), { filter_type: 'subscription', filter_url: 'https://example.com/feed' })
  assert.deepEqual(await streamParams(s, 'feed/https://example.com/feed'), { filter_type: 'subscription', filter_url: 'https://example.com/feed' })
  await assert.rejects(streamParams(s, 'saved'), /not available/)
})

test('fullContent: complete, newsletter, original fallback, summary', async () => {
  const long = `<p>${'complete sentence. '.repeat(120)}</p>`
  assert.equal((await fullContent({ html: long, url: 'https://example.com/a' }, undefined)).contentSource, 'inoreader')
  assert.equal((await fullContent({ html: '<p>short</p>', sourceId: 'feed/someone@ino.to' }, undefined)).contentSource, 'inoreader')

  const page = `<html><body><article><p>${'The whole story. '.repeat(40)}</p></article></body></html>`
  const fakeFetch = (async () => new Response(page, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  const orig = await fullContent({ html: '<p>Teaser … Read more</p>', url: 'https://example.com/a' }, undefined, fakeFetch)
  assert.equal(orig.contentSource, 'original')
  assert.match(orig.text, /^The whole story/)

  const empty = (async () => new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
  const sum = await fullContent({ html: '<p>Teaser … Read more</p>', url: 'https://example.com/a' }, undefined, empty)
  assert.equal(sum.contentSource, 'summary')
  assert.equal(sum.text, 'Teaser … Read more')
  // inoreader.com links (newsletters) are never fetched as "original".
  assert.equal((await fullContent({ html: '<p>x</p>', url: 'https://www.inoreader.com/article/abc' }, undefined, fakeFetch)).contentSource, 'summary')
})
