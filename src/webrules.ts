// Friendly <-> raw mapping for Inoreader rules and filters (web session).
// Raw = the web app's `save_rule` form / stored rule JSON; friendly = readable JSON specs.
// Enum codes come from the rule editor's own option lists.

export type Code = string | number

const invert = (m: Record<string, number>): Record<number, string> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]))

export const RULE_KINDS: Record<string, number> = { rule: 1, content_filter: 2, duplicate_filter: 3 }

// "When ..." trigger (filter_type)
export const TRIGGERS: Record<string, number> = {
  account: 0,
  folder: 1,
  feed: 2,
  tag: 4,
  read_later: 5,
  saved_web_page: 8,
  rule_matched: 9,
  team_channel: 10,
  intelligence_report: 11,
  upload: 12,
}

export const FIELDS: Record<string, number> = {
  title: 0,
  content: 1,
  author: 2,
  url_path: 3,
  title_or_content: 4,
  url: 5,
  has_attachments: 6,
  has_pictures: 7,
  has_video: 8,
  no_pictures: 9,
  no_video: 10,
  categories: 11,
  language: 12,
  description: 13,
  mention: 14,
}

export const OPS: Record<string, number> = {
  contains: 0,
  not_contains: 1,
  is: 2,
  is_not: 3,
  begins_with: 4,
  ends_with: 5,
  regex: 6,
  not_regex: 7,
}

export const MATCH: Record<string, number> = { all: 1, any: 2, everything: 3 }

export const FILTER_MODES: Record<string, number> = { remove: 0, keep: 1 }

export const ACTIONS: Record<string, number> = {
  read: 0,
  tag: 1,
  read_later: 2,
  team_channel: 3,
  email: 4,
  desktop_alert: 5,
  service_6: 6,
  instapaper: 7,
  service_8: 8,
  evernote: 9,
  onenote: 10,
  push: 11,
  remove: 12,
  dropbox: 13,
  none: 14,
  google_drive: 15,
  webhook: 16,
  summary: 17,
  translate: 18,
  raindrop: 19,
  note: 20,
}

const ALIASES: Record<string, string> = {
  star: 'read_later',
  mark_read: 'read',
  mark_as_read: 'read',
  notification: 'push',
  any_field: 'title_or_content',
  or: 'any',
  and: 'all',
  not_is: 'is_not',
  'doesnt_contain': 'not_contains',
}

// Duplicate-filter comparison period: the web form posts the slider index (1..12).
export const DEDUP_PERIODS: { index: number; seconds: number; label: string }[] = [
  [21600, '6h'],
  [43200, '12h'],
  [86400, '1d'],
  [172800, '2d'],
  [259200, '3d'],
  [345600, '4d'],
  [432000, '5d'],
  [518400, '6d'],
  [604800, '1w'],
  [1209600, '2w'],
  [1814400, '3w'],
  [2592000, '1m'],
].map(([seconds, label], i) => ({ index: i + 1, seconds: seconds as number, label: label as string }))

export function code(table: Record<string, number>, v: Code | undefined, what: string): number {
  if (typeof v === 'number') return v
  if (v === undefined || v === '') throw new Error(`missing ${what}`)
  if (/^-?\d+$/.test(v)) return Number(v)
  const key = v.toLowerCase().replace(/[\s-]+/g, '_')
  const hit = table[key] ?? table[ALIASES[key] ?? '']
  if (hit === undefined) throw new Error(`unknown ${what} "${v}" (one of: ${Object.keys(table).join(', ')})`)
  return hit
}

export function nameOf(table: Record<string, number>, c: Code | undefined | null): string | undefined {
  if (c === undefined || c === null || c === '') return undefined
  return invert(table)[Number(c)] ?? `code_${c}`
}

// ---------------------------------------------------------------------------
// Friendly spec

export interface ConditionSpec {
  field: Code
  op?: Code
  text?: string
  [k: string]: unknown
}

export interface ActionSpec {
  type: Code
  params?: string
  tag?: string
  tagId?: string
  to?: string
  template?: unknown
  url?: string
  prefix?: string
  text?: string
  organizationId?: string | number
  privacy?: string
  note?: string
  [k: string]: unknown
}

export interface DedupSpec {
  method?: 'url' | 'title_exact' | 'title_fuzzy'
  precision?: 'loose' | 'moderate' | 'strict'
  period?: Code
  [k: string]: unknown
}

export interface RuleSpec {
  id?: string
  name?: string
  kind?: Code
  enabled?: boolean
  trigger?: { type: Code; id?: string | number | null; [k: string]: unknown }
  match?: Code
  wholeWords?: boolean
  mode?: Code
  conditions?: ConditionSpec[]
  actions?: ActionSpec[]
  dedup?: DedupSpec
  runOnExisting?: boolean
  [k: string]: unknown
}

export type TagResolver = (name: string) => string | undefined

// ---------------------------------------------------------------------------
// Action params (the web editor packs several inputs into one string)

export function encodeActionParams(a: ActionSpec, resolveTag?: TagResolver): { type: number; params: string; newTag: string } {
  const type = code(ACTIONS, a.type, 'action type')
  if (a.params !== undefined) return { type, params: String(a.params), newTag: '' }
  switch (type) {
    case ACTIONS.tag: {
      if (a.tagId) return { type, params: String(a.tagId), newTag: '' }
      const t = a.tag?.trim()
      if (!t) throw new Error('tag action needs "tag" (name or id) or "tagId"')
      if (/^\d+$/.test(t)) return { type, params: t, newTag: '' }
      const id = resolveTag?.(t)
      return id ? { type, params: id, newTag: '' } : { type, params: 'new', newTag: t }
    }
    case ACTIONS.email: {
      if (!a.to) throw new Error('email action needs "to"')
      const to = a.to.replace(/\|/g, ',')
      const tpl = a.template === undefined ? '' : typeof a.template === 'string' ? a.template : JSON.stringify(a.template)
      return { type, params: tpl ? `${to}|${tpl}` : to, newTag: '' }
    }
    case ACTIONS.webhook:
      if (!a.url) throw new Error('webhook action needs "url"')
      return { type, params: a.url, newTag: '' }
    case ACTIONS.push:
      return { type, params: a.prefix ?? '', newTag: '' }
    case ACTIONS.note:
      return { type, params: `${a.organizationId ?? 0}|${a.text ?? ''}`, newTag: '' }
    case ACTIONS.team_channel:
      return { type, params: `${a.privacy ?? ''}|${a.note ?? ''}`, newTag: '' }
    default:
      return { type, params: '', newTag: '' }
  }
}

export function decodeAction(type: number, params: string, tagNames?: Map<string, string>): ActionSpec {
  const out: ActionSpec = { type: nameOf(ACTIONS, type)!, code: type }
  switch (type) {
    case ACTIONS.tag:
      out.tag = tagNames?.get(params) ?? params
      out.tagId = params
      break
    case ACTIONS.email: {
      const i = params.indexOf('|')
      out.to = i < 0 ? params : params.slice(0, i)
      if (i >= 0) {
        const rest = params.slice(i + 1)
        try {
          out.template = JSON.parse(rest)
        } catch {
          out.template = rest
        }
      }
      break
    }
    case ACTIONS.webhook:
      out.url = params
      break
    case ACTIONS.push:
      if (params) out.prefix = params
      break
    case ACTIONS.note: {
      const i = params.indexOf('|')
      const org = i < 0 ? '0' : params.slice(0, i)
      out.text = i < 0 ? params : params.slice(i + 1)
      if (org && org !== '0') out.organizationId = org
      break
    }
    case ACTIONS.team_channel: {
      const i = params.indexOf('|')
      out.privacy = i < 0 ? params : params.slice(0, i)
      out.note = i < 0 ? '' : params.slice(i + 1)
      break
    }
    default:
      if (params) out.params = params
  }
  return out
}

// ---------------------------------------------------------------------------
// Raw rule JSON (as embedded in the rule editor) -> friendly

const iso = (unix: unknown): string | null => (Number(unix) > 0 ? new Date(Number(unix) * 1000).toISOString() : null)

export function dedupFromRaw(r: Record<string, any>): DedupSpec & Record<string, unknown> {
  const field = r.deduplication_field
  const msm = r.deduplication_minimum_should_match
  const seconds = Number(r.deduplication_period) || null
  const p = DEDUP_PERIODS.find((x) => x.seconds === seconds)
  const method = field === 'url' ? 'url' : field === 'title' && String(msm) === '100' ? 'title_exact' : field === 'title' ? 'title_fuzzy' : undefined
  return {
    method,
    period: p?.label ?? seconds ?? undefined,
    periodSeconds: seconds,
    field: field ?? null,
    minimumShouldMatch: msm === null || msm === undefined ? null : Number(msm),
  }
}

export interface Lookups {
  tagNames?: Map<string, string>
  sourceNames?: Map<string, string> // key: `${triggerCode}:${id}`
}

export function normaliseRule(r: Record<string, any>, lk: Lookups = {}): RuleSpec {
  const ruleType = Number(r.rule_type)
  const triggerCode = Number(r.filter_type ?? 0)
  const triggerId = r.filter_id && String(r.filter_id) !== '0' ? String(r.filter_id) : undefined
  const scope = Number(r.match_scope ?? 1)
  const out: RuleSpec = {
    id: r.id !== undefined ? String(r.id) : undefined,
    name: r.name,
    kind: nameOf(RULE_KINDS, ruleType),
    kindCode: ruleType,
    enabled: String(r.rule_state) === '1',
    trigger: {
      type: nameOf(TRIGGERS, triggerCode)!,
      code: triggerCode,
      ...(triggerId ? { id: triggerId } : {}),
      ...(triggerId && lk.sourceNames?.get(`${triggerCode}:${triggerId}`)
        ? { name: lk.sourceNames.get(`${triggerCode}:${triggerId}`) }
        : {}),
    },
  }
  if (ruleType !== RULE_KINDS.duplicate_filter) {
    out.match = nameOf(MATCH, scope)
    out.matchCode = scope
    out.wholeWords = String(r.match_strict) === '1'
    out.conditions = (r.conditions ?? []).map((c: Record<string, any>) => {
      const f = Number(c.match_field)
      const o = Number(c.match_type)
      return { field: nameOf(FIELDS, f)!, fieldCode: f, op: nameOf(OPS, o)!, opCode: o, text: c.match_text ?? '' }
    })
  }
  if (ruleType === RULE_KINDS.content_filter) {
    out.mode = nameOf(FILTER_MODES, Number(r.filter_mode ?? 0))
    out.modeCode = Number(r.filter_mode ?? 0)
  }
  if (ruleType === RULE_KINDS.rule) {
    out.actions = (r.actions ?? []).map((a: Record<string, any>) => decodeAction(Number(a.type), String(a.params ?? ''), lk.tagNames))
  }
  if (ruleType === RULE_KINDS.duplicate_filter) out.dedup = dedupFromRaw(r)
  out.matches = r.matches !== undefined ? Number(r.matches) : undefined
  out.lastUpdate = iso(r.last_update)
  out.lastManualRun = iso(r.last_manual_run)
  return out
}

// ---------------------------------------------------------------------------
// Friendly -> save_rule form

export interface BuildOptions {
  ruleId?: string // "" / undefined = create
  context?: 'rules' | 'filters' | 'create_filter_btn'
  resolveTag?: TagResolver
}

function indexed<T>(list: T[], f: (x: T) => string): Record<string, string> {
  return Object.fromEntries(list.map((x, i) => [String(i), f(x)]))
}

export function kindOf(spec: RuleSpec, fallback = 1): number {
  return spec.kind === undefined ? fallback : code(RULE_KINDS, spec.kind, 'kind')
}

function conditionFields(spec: RuleSpec, form: Record<string, unknown>): void {
  const conds = (spec.conditions ?? []).map((c) => {
    const field = code(FIELDS, c.field, 'condition field')
    const op = c.op === undefined ? OPS.contains : code(OPS, c.op, 'condition op')
    const text = c.text === undefined || c.text === null ? '' : String(c.text)
    // "Detected language" posts the language in match_lang and an empty text box.
    return field === FIELDS.language
      ? { field, op, text: '', lang: text || 'en' }
      : { field, op, text, lang: typeof c.lang === 'string' ? c.lang : 'en' }
  })
  if (!conds.length) return
  form.match_field = indexed(conds, (c) => String(c.field))
  form.match_type = indexed(conds, (c) => String(c.op))
  form.match_text = indexed(conds, (c) => c.text)
  form.match_lang = indexed(conds, (c) => c.lang)
}

function scopeOf(spec: RuleSpec): number {
  const n = spec.conditions?.length ?? 0
  if (!n) return MATCH.everything
  const s = spec.match === undefined ? MATCH.all : code(MATCH, spec.match, 'match')
  return s === MATCH.everything ? MATCH.all : s
}

function triggerOf(spec: RuleSpec, required: boolean): { type: number; id: string } {
  const t = spec.trigger ?? (spec.source as RuleSpec['trigger'])
  if (!t) {
    if (required) throw new Error('missing "trigger" (e.g. {"type":"feed","id":"<subscription id>"})')
    return { type: TRIGGERS.account, id: '' }
  }
  const type = code(TRIGGERS, t.type, 'trigger type')
  const id = t.id === undefined || t.id === null ? '' : String(t.id)
  if ([TRIGGERS.folder, TRIGGERS.feed, TRIGGERS.tag, TRIGGERS.rule_matched].includes(type) && !id) {
    throw new Error(`trigger "${t.type}" needs an "id"`)
  }
  return { type, id }
}

export function periodIndex(p: Code | undefined): number {
  if (p === undefined || p === '') return 3 // the web form's default (1 day)
  if (typeof p === 'number' || /^\d+$/.test(p)) {
    const n = Number(p)
    if (n >= 1 && n <= DEDUP_PERIODS.length) return n
    const bySec = DEDUP_PERIODS.find((x) => x.seconds === n)
    if (bySec) return bySec.index
    throw new Error(`bad dedup period ${p}: use 1-12, seconds (${DEDUP_PERIODS.map((x) => x.seconds).join(', ')}) or a label`)
  }
  const hit = DEDUP_PERIODS.find((x) => x.label === p.toLowerCase())
  if (!hit) throw new Error(`bad dedup period "${p}" (one of: ${DEDUP_PERIODS.map((x) => x.label).join(', ')})`)
  return hit.index
}

export function buildSaveRuleForm(spec: RuleSpec, opts: BuildOptions = {}): Record<string, unknown> {
  const ruleId = opts.ruleId ?? ''
  const create = !ruleId
  const kind = kindOf(spec)
  const enabled = spec.enabled !== false

  if (kind === RULE_KINDS.rule) {
    if (!spec.name) throw new Error('rule needs a "name"')
    const t = triggerOf(spec, false)
    const form: Record<string, unknown> = {
      rule_id: ruleId,
      rule_context: opts.context ?? 'rules',
      match_scope: String(scopeOf(spec)),
      rule_type: '1',
      rule_run: spec.runOnExisting ? '1' : '0',
    }
    if (create) form.rule_name = spec.name
    form.filter_type = String(t.type)
    form.filter_id = t.id
    conditionFields(spec, form)
    // "Whole words only" is pre-ticked in the web editor; only an explicit false clears it.
    if (spec.wholeWords !== false && spec.conditions?.length) form.match_strict = '1'
    const acts = (spec.actions ?? []).map((a) => encodeActionParams(a, opts.resolveTag))
    if (acts.length) {
      form.action_type = indexed(acts, (a) => String(a.type))
      form.action_params = indexed(acts, (a) => a.params)
      form.new_tag = indexed(acts, (a) => a.newTag)
    }
    if (!create) {
      form.rule_name = spec.name
      // The web app sends rule_state only while the rule's switch is on.
      if (enabled) form.rule_state = 1
    }
    return form
  }

  const t = triggerOf(spec, true)
  if (t.type !== TRIGGERS.feed && t.type !== TRIGGERS.folder) throw new Error('filters apply to a "feed" or a "folder"')
  const base: Record<string, unknown> = {
    rule_id: ruleId,
    rule_context: opts.context ?? (create ? 'create_filter_btn' : 'filters'),
  }

  if (kind === RULE_KINDS.content_filter) {
    if (!spec.conditions?.length) throw new Error('a content filter needs at least one condition')
    const form: Record<string, unknown> = {
      ...base,
      rule_type: '2',
      organization_id: '',
      rule_run: '0',
      action_type: { 0: String(ACTIONS.remove) },
      action_params: { 0: '' },
      filter_id: t.id,
      filter_type: String(t.type),
      match_scope: String(scopeOf(spec)),
      filter_mode: String(spec.mode === undefined ? FILTER_MODES.remove : code(FILTER_MODES, spec.mode, 'mode')),
    }
    conditionFields(spec, form)
    if (spec.wholeWords !== false) form.match_strict = '1'
    if (!create && enabled) form.rule_state = 1
    return form
  }

  if (kind === RULE_KINDS.duplicate_filter) {
    const d = spec.dedup ?? {}
    const method = d.method ?? 'url'
    if (!['url', 'title_exact', 'title_fuzzy'].includes(method)) throw new Error(`bad dedup method "${method}"`)
    const form: Record<string, unknown> = {
      ...base,
      match_scope: '2',
      rule_type: '3',
      organization_id: '',
      rule_run: '0',
      action_type: { 0: String(ACTIONS.remove) },
      action_params: { 0: '' },
      filter_type: String(t.type),
      filter_id: t.id,
      deduplication_method: method,
      deduplication_method_advanced_precision: d.precision ?? 'strict',
      deduplication_period: periodIndex(d.period),
    }
    if (!create && enabled) form.rule_state = 1
    return form
  }
  throw new Error(`unsupported kind ${kind}`)
}

// Merge a partial friendly spec over the current (normalised) rule.
export function mergeSpec(current: RuleSpec, patch: RuleSpec): RuleSpec {
  const merged: RuleSpec = { ...current, ...patch }
  if (patch.dedup && current.dedup) merged.dedup = { ...current.dedup, ...patch.dedup }
  // Drop stale decoded codes so names always win.
  delete merged.kindCode
  delete merged.matchCode
  delete merged.modeCode
  return merged
}

// Raw form (as posted) -> friendly, used by tests to check the round trip.
export function formToSpec(form: Record<string, any>, tagNames?: Map<string, string>): RuleSpec {
  const vals = (o: Record<string, string> | undefined) => (o ? Object.keys(o).sort((a, b) => +a - +b).map((k) => o[k]) : [])
  const fields = vals(form.match_field)
  const types = vals(form.match_type)
  const texts = vals(form.match_text)
  const langs = vals(form.match_lang)
  const raw = {
    rule_type: form.rule_type,
    name: form.rule_name,
    rule_state: form.rule_state === undefined ? '1' : String(form.rule_state),
    filter_type: form.filter_type,
    filter_id: form.filter_id,
    match_scope: form.match_scope,
    match_strict: form.match_strict ?? '0',
    filter_mode: form.filter_mode,
    conditions: fields.map((f, i) => ({
      match_field: f,
      match_type: types[i],
      match_text: Number(f) === FIELDS.language ? langs[i] : texts[i],
    })),
    actions:
      String(form.rule_type) === '1'
        ? vals(form.action_type).map((t, i) => ({
            type: t,
            params: vals(form.action_params)[i] === 'new' ? vals(form.new_tag)[i] : vals(form.action_params)[i],
          }))
        : [],
  }
  return normaliseRule(raw, { tagNames })
}
