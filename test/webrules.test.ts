// Friendly <-> raw rule mapping. Synthetic data only.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIONS,
  FIELDS,
  buildSaveRuleForm,
  code,
  decodeAction,
  encodeActionParams,
  formToSpec,
  mergeSpec,
  normaliseRule,
  periodIndex,
  type RuleSpec,
} from '../src/webrules.ts'

const tags = new Map([
  ['3001', 'reading'],
  ['3002', 'Work'],
])
const resolveTag = (n: string) => [...tags].find(([, name]) => name.toLowerCase() === n.toLowerCase())?.[0]

test('code(): names, aliases, raw codes, errors', () => {
  assert.equal(code(FIELDS, 'title', 'field'), 0)
  assert.equal(code(FIELDS, 'Title or content', 'field'), 4)
  assert.equal(code(FIELDS, '5', 'field'), 5)
  assert.equal(code(FIELDS, 12, 'field'), 12)
  assert.equal(code(ACTIONS, 'star', 'action'), ACTIONS.read_later)
  assert.throws(() => code(FIELDS, 'nope', 'field'), /unknown field "nope"/)
})

test('rule create form matches the web editor payload', () => {
  const spec: RuleSpec = {
    name: 'Example rule',
    trigger: { type: 'feed', id: '2001' },
    match: 'any',
    conditions: [
      { field: 'title_or_content', op: 'contains', text: 'alpha' },
      { field: 'url', op: 'contains', text: 'example.org' },
    ],
    actions: [
      { type: 'tag', tag: 'Brand new tag' },
      { type: 'tag', tag: 'work' },
    ],
  }
  assert.deepEqual(buildSaveRuleForm(spec, { resolveTag }), {
    rule_id: '',
    rule_context: 'rules',
    match_scope: '2',
    rule_type: '1',
    rule_run: '0',
    rule_name: 'Example rule',
    filter_type: '2',
    filter_id: '2001',
    match_field: { 0: '4', 1: '5' },
    match_type: { 0: '0', 1: '0' },
    match_text: { 0: 'alpha', 1: 'example.org' },
    match_lang: { 0: 'en', 1: 'en' },
    match_strict: '1',
    action_type: { 0: '1', 1: '1' },
    action_params: { 0: 'new', 1: '3002' },
    new_tag: { 0: 'Brand new tag', 1: '' },
  })
})

test('rule update form: rule_name at the end, rule_state only when enabled', () => {
  const spec: RuleSpec = { name: 'R', wholeWords: false, conditions: [{ field: 'title', op: 'regex', text: '/x/i' }], actions: [{ type: 'read' }] }
  const on = buildSaveRuleForm(spec, { ruleId: '1001' })
  assert.equal(on.rule_id, '1001')
  assert.equal(on.filter_type, '0')
  assert.equal(on.filter_id, '')
  assert.equal(on.match_scope, '1')
  assert.equal(on.match_strict, undefined)
  assert.deepEqual(Object.keys(on).slice(-2), ['rule_name', 'rule_state'])
  assert.equal(on.rule_state, 1)
  const off = buildSaveRuleForm({ ...spec, enabled: false }, { ruleId: '1001' })
  assert.equal(off.rule_state, undefined)
  const run = buildSaveRuleForm({ ...spec, runOnExisting: true }, { ruleId: '1001' })
  assert.equal(run.rule_run, '1')
})

test('rule without conditions matches everything; without actions posts no action fields', () => {
  const f = buildSaveRuleForm({ name: 'All', match: 'any', actions: [] })
  assert.equal(f.match_scope, '3')
  assert.equal(f.match_field, undefined)
  assert.equal(f.action_type, undefined)
})

test('language condition posts the code in match_lang', () => {
  const f = buildSaveRuleForm({ name: 'L', conditions: [{ field: 'language', op: 'is', text: 'de' }] })
  assert.deepEqual(f.match_text, { 0: '' })
  assert.deepEqual(f.match_lang, { 0: 'de' })
})

test('content filter form matches the web payload', () => {
  const f = buildSaveRuleForm({
    kind: 'content_filter',
    trigger: { type: 'feed', id: '2002' },
    match: 'any',
    mode: 'remove',
    conditions: [
      { field: 'author', op: 'contains', text: 'someone' },
      { field: 'has_attachments', op: 'contains' },
    ],
  })
  assert.deepEqual(f, {
    rule_id: '',
    rule_context: 'create_filter_btn',
    rule_type: '2',
    organization_id: '',
    rule_run: '0',
    action_type: { 0: '12' },
    action_params: { 0: '' },
    filter_id: '2002',
    filter_type: '2',
    match_scope: '2',
    filter_mode: '0',
    match_field: { 0: '2', 1: '6' },
    match_type: { 0: '0', 1: '0' },
    match_text: { 0: 'someone', 1: '' },
    match_lang: { 0: 'en', 1: 'en' },
    match_strict: '1',
  })
  const upd = buildSaveRuleForm({ kind: 'content_filter', trigger: { type: 'folder', id: '4001' }, conditions: [{ field: 'title', text: 'x' }], mode: 'keep' }, { ruleId: '1101' })
  assert.equal(upd.rule_context, 'filters')
  assert.equal(upd.filter_mode, '1')
  assert.equal(upd.rule_state, 1)
  assert.throws(() => buildSaveRuleForm({ kind: 'content_filter', trigger: { type: 'feed', id: '1' } }), /at least one condition/)
  assert.throws(() => buildSaveRuleForm({ kind: 'content_filter', conditions: [{ field: 'title' }] }), /missing "trigger"/)
})

test('duplicate filter form and period mapping', () => {
  const f = buildSaveRuleForm({ kind: 'duplicate_filter', trigger: { type: 'feed', id: '2003' }, dedup: { method: 'title_fuzzy', precision: 'moderate', period: '3d' } })
  assert.equal(f.rule_type, '3')
  assert.equal(f.match_scope, '2')
  assert.equal(f.deduplication_method, 'title_fuzzy')
  assert.equal(f.deduplication_method_advanced_precision, 'moderate')
  assert.equal(f.deduplication_period, 5)
  assert.equal(periodIndex('1w'), 9)
  assert.equal(periodIndex(604800), 9)
  assert.equal(periodIndex(12), 12)
  assert.equal(periodIndex(undefined), 3)
  assert.throws(() => periodIndex('5w'))
})

test('action params: encode/decode for every packed format', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ type: 'email', to: 'a@example.com|b@example.com' }, 'a@example.com,b@example.com'],
    [{ type: 'email', to: 'a@example.com', template: { et: 2, es: 'Subj', eb: ['[CONTENT]'] } }, 'a@example.com|{"et":2,"es":"Subj","eb":["[CONTENT]"]}'],
    [{ type: 'webhook', url: 'https://example.com/hook' }, 'https://example.com/hook'],
    [{ type: 'push', prefix: 'News:' }, 'News:'],
    [{ type: 'note', text: 'a|b' }, '0|a|b'],
    [{ type: 'team_channel', privacy: '1', note: 'hi' }, '1|hi'],
    [{ type: 'read_later' }, ''],
    [{ type: 'summary', params: 'raw-value' }, 'raw-value'],
  ]
  for (const [spec, params] of cases) {
    const enc = encodeActionParams(spec as never)
    assert.equal(enc.params, params, JSON.stringify(spec))
    const dec = decodeAction(enc.type, enc.params)
    const back = encodeActionParams(dec)
    assert.equal(back.params, params, `round trip ${JSON.stringify(spec)}`)
  }
  assert.throws(() => encodeActionParams({ type: 'webhook' }), /url/)
  assert.deepEqual(decodeAction(ACTIONS.tag, '3001', tags), { type: 'tag', code: 1, tag: 'reading', tagId: '3001' })
})

test('normaliseRule decodes enums and keeps raw codes alongside', () => {
  const raw = {
    id: '1001',
    rule_state: '1',
    rule_type: '1',
    name: 'Example rule',
    filter_type: '4',
    filter_id: '3002',
    match_scope: '1',
    match_strict: '0',
    matches: '42',
    last_update: '1700000000',
    last_manual_run: '0',
    actions: [
      { type: '1', params: '3001' },
      { type: '0', params: '' },
    ],
    conditions: [{ match_field: '2', match_type: '1', match_text: 'bot' }],
  }
  const n = normaliseRule(raw, { tagNames: tags, sourceNames: new Map([['4:3002', 'Work']]) })
  assert.deepEqual(n, {
    id: '1001',
    name: 'Example rule',
    kind: 'rule',
    kindCode: 1,
    enabled: true,
    trigger: { type: 'tag', code: 4, id: '3002', name: 'Work' },
    match: 'all',
    matchCode: 1,
    wholeWords: false,
    conditions: [{ field: 'author', fieldCode: 2, op: 'not_contains', opCode: 1, text: 'bot' }],
    actions: [
      { type: 'tag', code: 1, tag: 'reading', tagId: '3001' },
      { type: 'read', code: 0 },
    ],
    matches: 42,
    lastUpdate: '2023-11-14T22:13:20.000Z',
    lastManualRun: null,
  })
  const dup = normaliseRule({ rule_type: '3', rule_state: '0', filter_type: '2', filter_id: '2001', deduplication_field: 'title', deduplication_minimum_should_match: '100', deduplication_period: '604800', actions: [], conditions: [] })
  assert.equal(dup.enabled, false)
  assert.deepEqual(dup.dedup, { method: 'title_exact', period: '1w', periodSeconds: 604800, field: 'title', minimumShouldMatch: 100 })
})

test('round trip: friendly -> form -> friendly', () => {
  const specs: RuleSpec[] = [
    {
      name: 'Round trip',
      trigger: { type: 'folder', id: '4001' },
      match: 'any',
      wholeWords: true,
      conditions: [
        { field: 'title', op: 'begins_with', text: 'Re:' },
        { field: 'language', op: 'is_not', text: 'fr' },
      ],
      actions: [
        { type: 'tag', tag: 'reading' },
        { type: 'email', to: 'me@example.com' },
        { type: 'webhook', url: 'https://example.com/h' },
        { type: 'read' },
      ],
    },
    { kind: 'content_filter', trigger: { type: 'feed', id: '2001' }, match: 'all', mode: 'keep', wholeWords: false, conditions: [{ field: 'content', op: 'regex', text: '/a|b/' }] },
  ]
  for (const spec of specs) {
    const form = buildSaveRuleForm(spec, { ruleId: '1001', resolveTag })
    const back = formToSpec(form, tags)
    // Re-building from the decoded spec must give the identical form.
    assert.deepEqual(buildSaveRuleForm(mergeSpec(back, {}), { ruleId: '1001', resolveTag }), form)
    assert.equal(back.match, spec.match)
    assert.equal(back.conditions?.length, spec.conditions?.length)
  }
})

test('mergeSpec: patch wins, stale codes are dropped', () => {
  const cur = normaliseRule({ id: '1', rule_type: '1', rule_state: '1', name: 'Old', match_scope: '2', actions: [], conditions: [{ match_field: '0', match_type: '0', match_text: 'x' }] })
  const m = mergeSpec(cur, { name: 'New', match: 'all' })
  assert.equal(m.name, 'New')
  assert.equal(m.matchCode, undefined)
  assert.equal(buildSaveRuleForm(m, { ruleId: '1' }).match_scope, '1')
})
