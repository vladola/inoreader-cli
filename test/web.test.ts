// Transport-level tests: encoding, xjxobj parsing, extractors, cookie input.
// All fixtures are synthetic and hand-written.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  WebError,
  WebSession,
  WebSessionExpired,
  alerts,
  cookieNames,
  decodeArg,
  encodeArg,
  encodeBody,
  extractAutocomplete,
  extractHighlighters,
  extractPreferenceItems,
  extractRule,
  extractRuleCopyList,
  extractToastId,
  parseCookieInput,
  parseRuleRows,
  parseRunResult,
  parseSpotlightDialog,
  parseSpotlightRows,
  parseTagOptions,
  parseXjx,
  probe,
  shellSplit,
  type XjxCmd,
} from '../src/web.ts'

test('encodeArg: S/N/B/* prefixes and JSON for objects and arrays', () => {
  assert.equal(encodeArg('rule_dialog'), 'Srule_dialog')
  assert.equal(encodeArg(''), 'S')
  assert.equal(encodeArg('a b&c'), 'Sa%20b%26c')
  assert.equal(encodeArg(1001), 'N1001')
  assert.equal(encodeArg(-1), 'N-1')
  assert.equal(encodeArg(true), 'Btrue')
  assert.equal(encodeArg(false), 'Bfalse')
  assert.equal(encodeArg(null), '*')
  assert.equal(encodeArg(undefined), '*')
  assert.equal(encodeArg({ type: 'rules' }), '%7B%22type%22%3A%22rules%22%7D')
  assert.equal(encodeArg(['1', '2']), '%5B%221%22%2C%222%22%5D')
  assert.throws(() => encodeArg(Number.NaN))
})

test('encodeBody: literal brackets, fn, xjxr timestamp, args in order', () => {
  const body = encodeBody('delete_rule', [1001, 'rules', null], 1700000000000)
  assert.equal(body, 'xjxfun=delete_rule&xjxr=1700000000000&xjxargs[]=N1001&xjxargs[]=Srules&xjxargs[]=*')
  const again = body
    .split('&')
    .filter((p) => p.startsWith('xjxargs[]='))
    .map((p) => decodeArg(p.slice(10)))
  assert.deepEqual(again, [1001, 'rules', null])
  assert.deepEqual(decodeArg(encodeArg({ a: [1, 'x'] })), { a: [1, 'x'] })
  assert.equal(decodeArg(encodeArg(false)), false)
})

test('parseXjx: command list, HTML and non-JSON become WebSessionExpired', () => {
  const cmds = parseXjx('{"xjxobj":[{"cmd":"js","data":"x()"},{"cmd":"jc","func":"f","data":[1]}]}')
  assert.equal(cmds.length, 2)
  assert.deepEqual(parseXjx('{"xjxobj":[]}'), [])
  assert.throws(() => parseXjx('<!DOCTYPE html><html>login</html>'), WebSessionExpired)
  assert.throws(() => parseXjx('{"xjxobj":[]}', 'text/html; charset=utf-8'), WebSessionExpired)
  assert.throws(() => parseXjx(''), WebSessionExpired)
  assert.throws(() => parseXjx('{"other":1}'), WebError)
  assert.throws(() => parseXjx('{"xjxobj":[{"cmd":"js","data":"window.location.href = \'/login\'"}]}'), WebSessionExpired)
})

const ruleJs = `var max_rules_match=999;
var max_rules_action=999;
var rule={"id":"1001","user_id":"1","rule_state":"1","rule_type":"1","name":"Example; {tricky} \\"name\\"","filter_type":"2","filter_id":"2001","filter_mode":"0","match_scope":"2","match_strict":"1","matches":"7","created_from":"main_web","last_update":"1700000000","last_manual_run":"0","organization_id":null,"actions":[{"id":"1","rule_id":"1001","state":"1","type":"1","params":"3001"}],"conditions":[{"id":"1","rule_id":"1001","state":"1","match_field":"0","match_type":"6","match_text":"\\/(foo|bar)\\/i"}]};
var form_id="rule_form_inline_1001";
window.init_rules_form = function (form_id, rule, suffix) {};`

test('extractRule: parses var rule= even with braces/quotes inside strings', () => {
  const r = extractRule([{ cmd: 'as', id: 'x', prop: 'innerHTML', data: '<form></form>' }, { cmd: 'js', data: ruleJs }])
  assert.ok(r)
  assert.equal(r.id, '1001')
  assert.equal(r.name, 'Example; {tricky} "name"')
  assert.equal(r.conditions[0].match_text, '/(foo|bar)/i')
  assert.equal(extractRule([{ cmd: 'js', data: 'var other={}' }]), undefined)
})

test('extractToastId, alerts, parseRunResult', () => {
  const saved: XjxCmd[] = [
    { cmd: 'jc', func: 'create_bottom_notification', data: ['Rule <a onclick="edit_rule(1234,\'rule_created_toast\')">X</a> created.', 'info', true] },
  ]
  assert.equal(extractToastId(saved), '1234')
  assert.equal(extractToastId([{ cmd: 'jc', func: 'create_bottom_notification', data: ['Feed filtered.', 'info', true] }]), undefined)
  const ran: XjxCmd[] = [
    {
      cmd: 'jc',
      func: 'xalert',
      data: [
        '<h3>Rule ran successfully!</h3><div>Total articles: <span>1,234</span></div><div>Matched articles: <span>5 /  0%</span></div><div>Processing time: <span>0.50 sec.</span></div>',
      ],
    },
  ]
  assert.deepEqual(alerts(ran).length, 1)
  const r = parseRunResult(ran)!
  assert.equal(r.totalArticles, 1234)
  assert.equal(r.matchedArticles, 5)
  assert.equal(r.seconds, 0.5)
})

test('extractHighlighters: spotlight ids per active term', () => {
  const cmds: XjxCmd[] = [
    { cmd: 'jc', func: 'stop_loading', data: [] },
    { cmd: 'js', data: 'highlighters=[{"term":"alpha","case_sensitive":"0","id":"501","org_id":0,"color_id":"2"},{"term":"b]eta","case_sensitive":"1","id":"502","org_id":0,"color_id":"3"}];' },
  ]
  const h = extractHighlighters(cmds)!
  assert.equal(h.length, 2)
  assert.equal(h[1].term, 'b]eta')
  assert.equal(h[1].id, '502')
  // toggle_highlighter prefixes the assignment with other statements
  const t = extractHighlighters([{ cmd: 'js', data: '$("#x").prop("checked", false);highlighters=[];' }])
  assert.deepEqual(t, [])
})

test('extractAutocomplete and extractRuleCopyList', () => {
  const ac = extractAutocomplete([
    {
      cmd: 'jc',
      func: 'autocomplete',
      data: [
        '#rule_form .subscription_autocomplete',
        {
          subscriptions: [{ id: '2001', rss_url: 'https://example.com/feed', url: 'https://example.com', type: 'rss', title: 'Example', feed_id: '9' }],
          folders: [{ id: '4001', title: 'Folder A' }],
          rules: [],
        },
      ],
    },
  ])!
  assert.equal(ac.subscriptions[0].id, '2001')
  assert.equal(ac.folders[0].title, 'Folder A')
  const list = extractRuleCopyList([
    { cmd: 'jc', func: 'build_rule_copy_select', data: ['rule_form', [{ id: '1001', name: 'R', filter_id: '0', filter_type: '0', rule_type: '1' }], null] },
  ])!
  assert.equal(list[0].name, 'R')
})

const rulesListHtml = `<div class="px-sm-3 feature_dashboard_wrapper"><div class="sort-row" data-sort-current="name"></div>
<div class="reader_pane_rules_wrapper print_rules page-container">
 <div class="preferences_rules_row border px-3 py-2 my-2" id="preferences_rules_row_1001"
   data-sort-field-name="Alpha &amp; beta" data-sort-field-date="1001" data-sort-field-matches="0"
   data-sort-field-status="1" data-sort-field-type="0" >
  <table><tr><td class="preferences_rules_row_descr"><div class="flex"><div class="preferences_rules_row_expand flex mr-3 "></div></div></td>
  <td class="text-sm text-muted-color " style="width: 30%;"> <div class="flex"> New article in feed Example <p class="text-xs text-muted-color font-weight-normal mb-0 ml-2" style="line-height: 14px;"></p> </div> </td>
  <td class="preferences_rules_row_matches"><a href="javascript:void(0)" onclick="show_dialog('rule_log_dialog',{ rule_id:1001});" class="underlink_hover"> 3 </a></td>
  <td><div class="preferences_rules_row_switch "><div class="apple-switch-wrapper"><input id="preferences_rules_row_enabled_1001" type="checkbox" class="apple-switch" checked onchange="toggle_rule(1001,this,'rules')"></div></div></td>
  <td><div class="inno_toolbar_button_menu_item redlink" onclick="delete_rule('1001','rules',1,'Alpha &amp; beta')">Delete rule</div></td></tr></table>
 </div>
 <div class="preferences_rules_row border px-3 py-2 my-2" id="preferences_rules_row_1002" data-sort-field-name="Gamma" data-sort-field-status="0">
  <td><input id="preferences_rules_row_enabled_1002" type="checkbox" class="apple-switch" onchange="toggle_rule(1002,this,'rules')"></td>
 </div>
</div>`

const filtersListHtml = `<div class="reader_pane_rules_wrapper">
 <div class="preferences_rules_row border px-3 py-2 my-2" id="preferences_rules_row_1101" data-sort-field-name="Example Feed" data-sort-field-matches="0" data-sort-field-status="1">
  <div class="flex"> <span class="preferences_rules_row_filter_type"><span class="h4 icon-duplicates-filter"></span></span>
  <p class="text-xs text-muted-color font-weight-normal mb-0 ml-2" style="line-height: 14px;">Remove duplicates</p> </div>
  <a href="javascript:void(0)" onclick="show_dialog('rule_log_dialog',{ rule_id:1101});"> 12 </a>
  <input type="checkbox" class="apple-switch" checked onchange="toggle_rule(1101,this,'filters')">
  <a href="/subscription/x" onclick1="view_tree_element('subscription',2001,false,false,event,true);"></a>
  <div onclick="delete_rule('1101','filters',3,'Example Feed')"></div>
 </div>
</div>`

test('parseRuleRows: rules list', () => {
  const rows = parseRuleRows(rulesListHtml)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    id: '1001',
    name: 'Alpha & beta',
    enabled: true,
    matches: 3,
    context: 'rules',
    ruleType: 1,
    trigger: 'New article in feed Example',
    subtitle: null,
    source: null,
  })
  assert.equal(rows[1].enabled, false)
})

test('parseRuleRows: filters list (kind, shown count, source)', () => {
  const [f] = parseRuleRows(filtersListHtml)
  assert.equal(f.id, '1101')
  assert.equal(f.ruleType, 3)
  assert.equal(f.matches, 12)
  assert.equal(f.subtitle, 'Remove duplicates')
  assert.deepEqual(f.source, { kind: 'subscription', id: '2001' })
})

test('parseSpotlightRows', () => {
  const html = `<div class="px-sm-3 spotlights-list">
  <div class="preferences_rules_row border px-3 py-2 my-2 position-relative" id="preferences_rules_row_501" data-sort-field-name="alpha" data-sort-field-color="5" data-sort-field-date="1700000000" data-sort-field-user="" data-sort-field-status="1">
   <input class="form-check-input subscription_checks" type="checkbox" id="element_check_501" value="501">
   <input type="checkbox" class="apple-switch" checked onchange="toggle_highlighter(501,this.checked)">
  </div>
  <div class="preferences_rules_row border px-3 py-2 my-2 position-relative" id="preferences_rules_row_502" data-sort-field-name="beta" data-sort-field-color="1" data-sort-field-date="1700000100" data-sort-field-status="0">
   <input type="checkbox" class="apple-switch" onchange="toggle_highlighter(502,this.checked)">
  </div></div>`
  const rows = parseSpotlightRows(html)
  assert.deepEqual(rows[0], { id: '501', name: 'alpha', color: 5, enabled: true, createdAt: '2023-11-14T22:13:20.000Z' })
  assert.equal(rows[1].enabled, false)
})

test('parseTagOptions', () => {
  const html = `<select name="action_params[]" class="form-select"><option value="new" >Add tag</option><option value="3001" >alpha</option><option value="3002" selected>b &amp; c</option></select> <input name="new_tag[]">`
  assert.deepEqual(parseTagOptions(html), [
    { id: '3001', name: 'alpha', selected: false },
    { id: '3002', name: 'b & c', selected: true },
  ])
})

test('parseSpotlightDialog', () => {
  const cmds: XjxCmd[] = [
    {
      cmd: 'as',
      id: 'rule_inline_editor_501',
      prop: 'innerHTML',
      data: `<div class="highlighter_content"><input type="text" class="form-control" id="highlighter_description" maxlength="1000" value="A &quot;note&quot;" onkeypress="x">
      <input type="checkbox" id="highlighter_team_members_501" value="1"  class="form-check-input mr-2">
      <input type="hidden" id="hl_color_id_501" class="hl_color_id form-check-input" value="7"></div>`,
    },
    { cmd: 'jc', func: 'add_highlighter_term', data: [501, { id: '601', term: 'alpha', case_sensitive: '0' }] },
    { cmd: 'jc', func: 'add_highlighter_term', data: [501, { id: '602', term: 'Beta', case_sensitive: '1' }] },
  ]
  assert.deepEqual(parseSpotlightDialog(cmds), {
    description: 'A "note"',
    color: 7,
    team: false,
    terms: [
      { id: '601', term: 'alpha', caseSensitive: false },
      { id: '602', term: 'Beta', caseSensitive: true },
    ],
  })
})

test('extractPreferenceItems: reads one section of the page bootstrap', () => {
  const page = `<script>var preference_sections = {"account":{"sections":{"emails_from_inoreader":{"label":"Emails","tab":true,"items":[{"label":"News","desc":"a } brace","name":"newsletter","value":true},{"label":"Other","name":"top_stories_reminder"}]},"reset":{"items":[]}}}};</script>`
  const items = extractPreferenceItems(page, 'emails_from_inoreader')!
  assert.equal(items.length, 2)
  assert.equal(items[0].value, true)
  assert.equal(items[1].value, undefined)
  assert.equal(extractPreferenceItems(page, 'missing'), undefined)
})

test('parseCookieInput: raw header, header line, and Copy-as-cURL variants', () => {
  assert.deepEqual(parseCookieInput('a=1; b=2\n'), { cookie: 'a=1; b=2', userAgent: undefined })
  assert.deepEqual(parseCookieInput('Cookie: a=1; b=2;'), { cookie: 'a=1; b=2', userAgent: undefined })
  const curlB = `curl 'https://www.example.com/?xjxfun=x' \\
  -H 'accept: */*' \\
  -b 'a=1; b=two%20words' \\
  -H 'user-agent: Test Agent/1.0' \\
  --data-raw 'xjxfun=x'`
  assert.deepEqual(parseCookieInput(curlB), { cookie: 'a=1; b=two%20words', userAgent: 'Test Agent/1.0' })
  const curlH = `curl "https://www.example.com/" -H "Cookie: a=1; b=\\"q\\"" -A 'UA/2'`
  assert.deepEqual(parseCookieInput(curlH), { cookie: 'a=1; b="q"', userAgent: 'UA/2' })
  const curlAnsi = `curl 'https://x' -H $'cookie: a=1; b=it\\'s'`
  assert.equal(parseCookieInput(curlAnsi).cookie, "a=1; b=it's")
  assert.throws(() => parseCookieInput(''))
  assert.throws(() => parseCookieInput('curl https://x -H "accept: */*"'))
  assert.throws(() => parseCookieInput('not a cookie'))
  assert.deepEqual(cookieNames('a=1; b=2=3'), ['a', 'b'])
})

test('shellSplit handles quotes and continuations', () => {
  assert.deepEqual(shellSplit(`a 'b c' "d \\"e\\"" f\\ g \\\n h`), ['a', 'b c', 'd "e"', 'f g', 'h'])
})

// A fake fetch that records requests; nothing leaves the process.
function fakeFetch(responses: (string | { status: number; body?: string; headers?: Record<string, string> })[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift() ?? '{"xjxobj":[]}'
    const spec = typeof r === 'string' ? { status: 200, body: r } : r
    return new Response(spec.body ?? '', { status: spec.status, headers: { 'content-type': 'application/json', ...spec.headers } })
  }) as unknown as typeof fetch
  return { f, calls }
}

const creds = { cookie: 'a=1; b=2', userAgent: 'UA/test', savedAt: '2020-01-01T00:00:00.000Z' }

test('WebSession: request shape, headers, dry-run and throttling', async () => {
  const { f, calls } = fakeFetch(['{"xjxobj":[{"cmd":"js","data":"ok()"}]}'])
  const s = new WebSession({ credentials: creds, fetch: f, delayMs: 0 })
  const cmds = await s.read('print_rules', [{ type: 'rules' }], '/rules')
  assert.equal(cmds.length, 1)
  assert.equal(calls[0].url, 'https://www.inoreader.com/?xjxfun=print_rules')
  const h = calls[0].init.headers as Record<string, string>
  assert.equal(h.cookie, 'a=1; b=2')
  assert.equal(h.referer, 'https://www.inoreader.com/rules')
  assert.equal(h.origin, 'https://www.inoreader.com')
  assert.equal(h['user-agent'], 'UA/test')
  assert.equal(h['content-type'], 'application/x-www-form-urlencoded')
  assert.match(String(calls[0].init.body), /^xjxfun=print_rules&xjxr=\d+&xjxargs\[\]=%7B%22type%22%3A%22rules%22%7D$/)

  const dry = new WebSession({ credentials: creds, fetch: f, dryRun: true, delayMs: 0 })
  assert.deepEqual(await dry.write('delete_rule', [1, 'rules', null], '/rules'), [])
  assert.equal(calls.length, 1)
  assert.deepEqual(dry.planned, [{ fn: 'delete_rule', args: [1, 'rules', null], referer: '/rules' }])

  const slow = fakeFetch(['{"xjxobj":[]}', '{"xjxobj":[]}'])
  const t = new WebSession({ credentials: creds, fetch: slow.f, delayMs: 120 })
  const t0 = Date.now()
  await t.read('a')
  await t.read('b')
  assert.ok(Date.now() - t0 >= 110)
})

test('WebSession: expiry detection (redirect, 403, HTML, missing credentials)', async () => {
  const expired: { status: number; body?: string; headers?: Record<string, string> }[] = [
    { status: 302, headers: { location: '/login' } },
    { status: 403, body: 'blocked' },
    { status: 200, body: '<html></html>', headers: { 'content-type': 'text/html' } },
  ]
  for (const r of expired) {
    const s = new WebSession({ credentials: creds, fetch: fakeFetch([r]).f, delayMs: 0 })
    await assert.rejects(s.read('x'), WebSessionExpired)
  }
  const none = new WebSession({ credentials: { ...creds, cookie: '' }, fetch: fakeFetch([]).f, delayMs: 0 })
  await assert.rejects(none.read('x'), WebSessionExpired)
})

test('probe: needs a tag <select> in the response', async () => {
  const ok = fakeFetch(['{"xjxobj":[{"cmd":"as","id":"tags_probe","prop":"innerHTML","data":"<select><option value=\\"new\\">Add</option><option value=\\"1\\">x</option></select>"}]}'])
  assert.deepEqual(await probe(new WebSession({ credentials: creds, fetch: ok.f, delayMs: 0 })), { tags: 1 })
  const bad = fakeFetch(['{"xjxobj":[]}'])
  await assert.rejects(probe(new WebSession({ credentials: creds, fetch: bad.f, delayMs: 0 })), WebSessionExpired)
})
