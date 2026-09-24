// `inoreader web ...` — commands backed by the web-session transport (web.ts).

import { readFileSync } from 'node:fs'
import {
  DEFAULT_USER_AGENT,
  LOGIN_HINT,
  WebError,
  WebSession,
  WebSessionExpired,
  alerts,
  assigned,
  cookieNames,
  extractAutocomplete,
  extractHighlighters,
  extractPreferenceItems,
  extractRule,
  extractToastId,
  loadWebCredentials,
  notifications,
  parseCookieInput,
  parseRuleRows,
  parseRunResult,
  parseSpotlightDialog,
  parseSpotlightRows,
  parseTagOptions,
  probe,
  removeWebCredentials,
  saveWebCredentials,
  webStoreLocation,
  type Autocomplete,
  type RawRule,
  type RuleRow,
  type XjxCmd,
} from './web.ts'
import {
  ACTIONS,
  RULE_KINDS,
  TRIGGERS,
  buildSaveRuleForm,
  kindOf,
  mergeSpec,
  normaliseRule,
  type Lookups,
  type RuleSpec,
} from './webrules.ts'

export const WEB_USAGE = `Web session (unofficial web-app API: rules, filters, spotlights, settings):
  web login [--user-agent UA]       read a Cookie header or a DevTools "Copy as cURL"
                                    command from stdin, verify it, store it (Keychain)
  web status | web logout
  web rules | web filters           list with enabled flag and match counts
  web spotlights                    list spotlights
  web tags                          tag id <-> name (for rule specs)
  web sources [--type T]            subscriptions (rss|keyword|webfeed|user_newsletter)
                                    and folders, with the ids rule/filter triggers use
  web rule get ID [--raw]           full rule; enums decoded, raw codes alongside
  web rule create [--file F]        JSON spec from --file or stdin (see README)
  web rule update ID [--file F]     partial spec, merged over the current rule
  web rule rename ID NAME
  web rule enable|disable|run ID    run = apply to recent existing articles
  web rule delete ID --yes
  web rule export                   all rules and filters as friendly JSON
  web filter get ID
  web filter create [--file F]      content filter; "kind":"duplicate_filter" (experimental)
  web filter update ID [--file F]   (experimental)
  web filter enable|disable ID  |  web filter delete ID --yes
  web spotlight get ID
  web spotlight create [--file F]   {"name","terms":[...],"color":1-10,"description"}
  web spotlight update ID [--file F]            (experimental)
  web spotlight enable|disable ID...  |  web spotlight delete ID... --yes
  web sub active SUB_ID on|off      feed "active" switch
  web sub bulk enable|disable|unfile|add-to-folder|unfollow SUB_ID... [--folder FOLDER_ID]
                                    (experimental; unfollow needs --yes)
  web output-feed ID on|off --kind tag|folder|system   public output feed of a tag/folder
                                    (negative system ids after --, e.g. --kind system -- -1 on)
  web folder create NAME --feeds SUB_ID,...  |  web tag create NAME      (experimental)
  web folder delete ID --yes [--unfollow]    |  web tag delete ID --yes  (experimental)
  web monitor create [--file F]  |  web monitor edit SUB_ID [--file F]    (experimental)
  web email-prefs                   "Emails from Inoreader" checkboxes (experimental read)
  web email-pref set KEY on|off     KEY: ${'newsletter|stars_email_reminder|top_stories_reminder|onboarding_emails|idle_user_email_reminder'}
  web raw FN [JSON_ARG...]          call any xajax function (args parsed as JSON, else string)

  Every write accepts --dry-run (prints the decoded {fn, args}; sends nothing, reads still
  run). Deletes need --yes. Calls are spaced ≥0.75 s apart (INOREADER_WEB_DELAY_MS).
`

const REF = {
  rules: '/rules',
  filters: '/filters',
  spotlights: '/highlighters',
  feeds: '/preferences/content/feeds',
  folders: '/preferences/content/folders',
  tags: '/preferences/content/tags',
  system: '/preferences/content/system_folders',
  prefs: '/preferences',
  root: '/',
}

export const EMAIL_PREF_KEYS = [
  'newsletter',
  'stars_email_reminder',
  'top_stories_reminder',
  'onboarding_emails',
  'idle_user_email_reminder',
]

type Ctx = 'rules' | 'filters'
type Opts = Record<string, any>

function experimental(note: string): void {
  process.stderr.write(`${JSON.stringify({ experimental: true, note })}\n`)
}

function need(args: string[], n: number, what: string): void {
  if (args.length < n) throw new Error(`usage: inoreader web ${what}`)
}

function requireYes(o: Opts, what: string): void {
  if (!o.yes && !o['dry-run']) throw new Error(`refusing to ${what} without --yes`)
}

function onOff(v: string | undefined, what: string): boolean {
  if (v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  throw new Error(`usage: inoreader web ${what} on|off`)
}

function numId(id: string): number {
  if (!/^-?\d+$/.test(id)) throw new Error(`expected a numeric id, got "${id}"`)
  return Number(id)
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('expected input on stdin (pipe it in, or use --file)')
  let s = ''
  for await (const chunk of process.stdin) s += chunk
  return s
}

async function readSpec<T = Record<string, any>>(o: Opts): Promise<T> {
  const text = o.file ? readFileSync(o.file, 'utf8') : await readStdin()
  try {
    return JSON.parse(text) as T
  } catch (e) {
    throw new Error(`spec is not valid JSON: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------------------
// Reads shared by several commands

async function listRuleRows(s: WebSession, ctx: Ctx): Promise<RuleRow[]> {
  const cmds = await s.read('print_rules', [{ type: ctx }], REF[ctx])
  const html = assigned(cmds, 'reader_pane')
  if (html === undefined) throw new WebError(`print_rules returned no list for "${ctx}"`)
  return parseRuleRows(html)
}

async function listTags(s: WebSession): Promise<{ id: string; name: string }[]> {
  const cmds = await s.read('get_rule_tags', ['tags_0', null], REF.rules)
  return parseTagOptions(assigned(cmds, 'tags_0') ?? '').map(({ id, name }) => ({ id, name }))
}

async function loadSources(s: WebSession): Promise<Autocomplete> {
  const cmds = await s.read(
    'fill_dialog',
    ['rule_dialog', { context: 'create_filter_btn', filter_id: '', filter_type: '', rule_type: '2' }],
    REF.filters,
  )
  const ac = extractAutocomplete(cmds)
  if (!ac) throw new WebError('could not read the source list (no autocomplete data)')
  return ac
}

async function getRawRule(s: WebSession, id: string, ctx: Ctx): Promise<RawRule> {
  numId(id)
  const cmds = await s.read('fill_dialog', ['rule_dialog', { rule_id: id, inline: true, context: ctx }], REF[ctx])
  const r = extractRule(cmds)
  if (!r || String(r.id) !== id) throw new WebError(`rule ${id} not found`)
  return r
}

function tagResolver(tags: { id: string; name: string }[]) {
  return (name: string) =>
    tags.find((t) => t.name === name)?.id ?? tags.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id
}

const needsTagLookup = (spec: RuleSpec) =>
  (spec.actions ?? []).some(
    (a) =>
      a.params === undefined &&
      !a.tagId &&
      String(a.type) !== '' &&
      (a.type === 'tag' || Number(a.type) === ACTIONS.tag) &&
      !/^\d+$/.test(String(a.tag ?? '')),
  )

async function lookups(s: WebSession, opts: { sources?: boolean } = {}): Promise<Lookups & { tags: { id: string; name: string }[] }> {
  const tags = await listTags(s)
  const tagNames = new Map(tags.map((t) => [t.id, t.name]))
  const sourceNames = new Map<string, string>()
  for (const t of tags) sourceNames.set(`${TRIGGERS.tag}:${t.id}`, t.name)
  if (opts.sources) {
    const ac = await loadSources(s)
    for (const x of ac.subscriptions) sourceNames.set(`${TRIGGERS.feed}:${x.id}`, x.title)
    for (const f of ac.folders) sourceNames.set(`${TRIGGERS.folder}:${f.id}`, f.title)
  }
  return { tags, tagNames, sourceNames }
}

function checkSaved(cmds: XjxCmd[], dryRun: boolean): string | undefined {
  if (dryRun) return undefined
  const notes = notifications(cmds)
  const errs = alerts(cmds)
  if (!notes.length && errs.length) throw new WebError(errs.join(' | '))
  return notes.map((n) => n.replace(/<[^>]+>/g, '')).join(' | ') || undefined
}

function planned(s: WebSession) {
  return { dryRun: true, calls: s.planned.map(({ fn, referer, args }) => ({ fn, referer, args })) }
}

// ---------------------------------------------------------------------------
// Rules & filters

async function saveRuleOrFilter(s: WebSession, spec: RuleSpec, ctx: Ctx, id?: string) {
  const kind = kindOf(spec, ctx === 'rules' ? RULE_KINDS.rule : RULE_KINDS.content_filter)
  if (ctx === 'rules' && kind !== RULE_KINDS.rule) throw new Error('this spec is a filter — use `inoreader web filter ...`')
  if (ctx === 'filters' && kind === RULE_KINDS.rule) throw new Error('this spec is a rule — use `inoreader web rule ...`')
  if (kind === RULE_KINDS.duplicate_filter) experimental('duplicate filters: form fields taken from the web editor, save never captured')
  if (id && kind !== RULE_KINDS.rule) experimental('filter update: shape inferred from filter create + rule update')

  const tags = needsTagLookup(spec) ? await listTags(s) : []
  const form = buildSaveRuleForm({ ...spec, kind }, { ruleId: id ?? '', resolveTag: tagResolver(tags) })
  const before = !id && !s.dryRun && kind !== RULE_KINDS.rule ? await listRuleRows(s, 'filters') : []

  const cmds = await s.write('save_rule', [form], REF[ctx])
  const message = checkSaved(cmds, s.dryRun)

  let newId = id
  if (!id && !s.dryRun) {
    newId = extractToastId(cmds)
    if (!newId) {
      const known = new Set(before.map((r) => r.id))
      const after = await listRuleRows(s, ctx)
      newId = after
        .filter((r) => !known.has(r.id))
        .map((r) => r.id)
        .sort((a, b) => Number(b) - Number(a))[0]
    }
  }
  // Creating always yields an enabled rule; honour an explicit "enabled": false.
  if (spec.enabled === false && !id) {
    await s.write('deactivate_rule', [newId ? Number(newId) : '<new id>', ctx], REF[ctx])
  }
  if (s.dryRun) return planned(s)
  return { ok: true, id: newId ?? null, message }
}

async function ruleCommand(s: WebSession, ctx: Ctx, sub: string, args: string[], o: Opts): Promise<unknown> {
  const noun = ctx === 'rules' ? 'rule' : 'filter'
  switch (sub) {
    case 'get': {
      need(args, 1, `${noun} get ID`)
      const raw = await getRawRule(s, args[0], ctx)
      if (o.raw) return raw
      const lk = raw.actions?.some((a) => Number(a.type) === ACTIONS.tag) || Number(raw.filter_type) === TRIGGERS.tag ? await lookups(s) : {}
      return normaliseRule(raw, lk)
    }
    case 'create':
      return saveRuleOrFilter(s, await readSpec<RuleSpec>(o), ctx)
    case 'update': {
      need(args, 1, `${noun} update ID [--file F]`)
      const patch = await readSpec<RuleSpec>(o)
      const current = normaliseRule(await getRawRule(s, args[0], ctx))
      const res = await saveRuleOrFilter(s, mergeSpec(current, patch), ctx, args[0])
      if (patch.enabled !== undefined && patch.enabled !== current.enabled) {
        await s.write(patch.enabled ? 'activate_rule' : 'deactivate_rule', [Number(args[0]), ctx], REF[ctx])
        if (s.dryRun) return planned(s)
      }
      return res
    }
    case 'rename': {
      if (ctx !== 'rules') throw new Error('filters are named after their source and cannot be renamed')
      need(args, 2, 'rule rename ID NAME')
      const current = normaliseRule(await getRawRule(s, args[0], ctx))
      return saveRuleOrFilter(s, mergeSpec(current, { name: args.slice(1).join(' ') }), ctx, args[0])
    }
    case 'enable':
    case 'disable': {
      need(args, 1, `${noun} ${sub} ID`)
      await s.write(sub === 'enable' ? 'activate_rule' : 'deactivate_rule', [numId(args[0]), ctx], REF[ctx])
      return s.dryRun ? planned(s) : { ok: true, id: args[0], enabled: sub === 'enable' }
    }
    case 'delete': {
      need(args, 1, `${noun} delete ID --yes`)
      requireYes(o, `delete ${noun} ${args[0]}`)
      const cmds = await s.write('delete_rule', [numId(args[0]), ctx, null], REF[ctx])
      if (s.dryRun) return planned(s)
      const errs = alerts(cmds)
      if (errs.length) throw new WebError(errs.join(' | '))
      return { ok: true, id: args[0], deleted: true }
    }
    case 'run': {
      if (ctx !== 'rules') throw new Error('only rules can be run on existing articles')
      need(args, 1, 'rule run ID')
      numId(args[0])
      const cmds = await s.write('run_rule_action', [args[0]], REF.rules)
      if (s.dryRun) return planned(s)
      const r = parseRunResult(cmds)
      if (!r) throw new WebError('rule run returned no result')
      if (r.totalArticles === null) throw new WebError(r.message)
      return { ok: true, id: args[0], ...r }
    }
    case 'export': {
      if (ctx !== 'rules') throw new Error('use `inoreader web rule export` (it includes filters)')
      const lk = await lookups(s, { sources: true })
      const rules = await listRuleRows(s, 'rules')
      const filters = await listRuleRows(s, 'filters')
      for (const r of rules) lk.sourceNames!.set(`${TRIGGERS.rule_matched}:${r.id}`, r.name)
      const out = { exportedAt: new Date().toISOString(), rules: [] as RuleSpec[], filters: [] as RuleSpec[] }
      for (const r of rules) out.rules.push(normaliseRule(await getRawRule(s, r.id, 'rules'), lk))
      for (const f of filters) out.filters.push(normaliseRule(await getRawRule(s, f.id, 'filters'), lk))
      return out
    }
    default:
      throw new Error(`unknown ${noun} subcommand: ${sub}\n\n${WEB_USAGE}`)
  }
}

// ---------------------------------------------------------------------------
// Spotlights

interface SpotlightSpec {
  name?: string
  description?: string
  color?: number | string
  team?: boolean
  enabled?: boolean
  terms?: (string | { term: string; caseSensitive?: boolean; case_sensitive?: boolean | number | string; id?: string | number })[]
}

const termOf = (t: NonNullable<SpotlightSpec['terms']>[number]) =>
  typeof t === 'string'
    ? { term: t, caseSensitive: false }
    : { term: t.term, caseSensitive: !!(t.caseSensitive ?? (t.case_sensitive !== undefined && String(t.case_sensitive) !== '0' && t.case_sensitive !== false)) }

function colorOf(c: SpotlightSpec['color'], fallback: number): string {
  const n = c === undefined ? fallback : Number(c)
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('spotlight color must be 1-10')
  return String(n)
}

async function listSpotlights(s: WebSession) {
  const cmds = await s.read('print_highlighters', [], REF.spotlights)
  const html = assigned(cmds, 'reader_pane')
  if (html === undefined) throw new WebError('print_highlighters returned no list')
  return parseSpotlightRows(html)
}

async function getSpotlight(s: WebSession, id: string) {
  numId(id)
  const row = (await listSpotlights(s)).find((r) => r.id === id)
  if (!row) throw new WebError(`spotlight ${id} not found`)
  const dlg = parseSpotlightDialog(await s.read('fill_dialog', ['highlighter_dialog', { id: Number(id), inline: true }], REF.spotlights))
  return { ...row, ...dlg, color: dlg.color ?? row.color }
}

async function spotlightCommand(s: WebSession, sub: string, args: string[], o: Opts): Promise<unknown> {
  switch (sub) {
    case 'get':
      need(args, 1, 'spotlight get ID')
      return getSpotlight(s, args[0])
    case 'create': {
      const spec = await readSpec<SpotlightSpec>(o)
      if (!spec.name) throw new Error('spotlight needs a "name"')
      const terms = (spec.terms ?? []).map(termOf).filter((t) => t.term)
      if (!terms.length) throw new Error('spotlight needs at least one term')
      const post = {
        id: 0,
        name: spec.name,
        team: spec.team ? 1 : 0,
        description: spec.description ?? '',
        color: colorOf(spec.color, 1),
        terms: terms.map((t) => ({ id: 0, term: t.term, case_sensitive: t.caseSensitive ? 1 : 0 })),
        context: 'highlighters',
      }
      const cmds = await s.write('save_highlighter', [post], REF.spotlights)
      if (s.dryRun) {
        if (spec.enabled === false) await s.write('toggle_highlighter', ['<new id>', false], REF.spotlights)
        return planned(s)
      }
      const errs = alerts(cmds)
      if (errs.length) throw new WebError(errs.join(' | '))
      // The response re-sends every active spotlight term with its spotlight id; the new
      // spotlight is the newest id whose term set equals ours.
      const want = new Set(terms.map((t) => t.term))
      const byId = new Map<string, Set<string>>()
      for (const h of extractHighlighters(cmds) ?? []) (byId.get(h.id) ?? byId.set(h.id, new Set()).get(h.id)!).add(h.term)
      let id = [...byId]
        .filter(([, set]) => set.size === want.size && [...want].every((t) => set.has(t)))
        .map(([k]) => k)
        .sort((a, b) => Number(b) - Number(a))[0]
      if (!id) id = (await listSpotlights(s)).filter((r) => r.name === spec.name).map((r) => r.id).sort((a, b) => Number(b) - Number(a))[0]
      if (spec.enabled === false && id) await s.write('toggle_highlighter', [Number(id), false], REF.spotlights)
      return { ok: true, id: id ?? null }
    }
    case 'update': {
      need(args, 1, 'spotlight update ID [--file F]')
      experimental('spotlight update: payload built from the web editor code; an edit was never captured')
      const spec = await readSpec<SpotlightSpec>(o)
      const cur = await getSpotlight(s, args[0])
      const terms = spec.terms ? spec.terms.map(termOf).filter((t) => t.term) : cur.terms
      if (!terms.length) throw new Error('spotlight needs at least one term')
      const post: Record<string, unknown> = { id: Number(args[0]) }
      // The inline editor never posts a name; only send one when it actually changes.
      if (spec.name && spec.name !== cur.name) post.name = spec.name
      Object.assign(post, {
        team: (spec.team ?? cur.team) ? 1 : 0,
        description: spec.description ?? cur.description,
        color: colorOf(spec.color, cur.color ?? 1),
        terms: terms.map((t) => ({
          id: Number(cur.terms.find((c) => c.term === t.term)?.id ?? 0),
          term: t.term,
          case_sensitive: t.caseSensitive ? 1 : 0,
        })),
        context: 'highlighters',
      })
      const cmds = await s.write('save_highlighter', [post], REF.spotlights)
      if (spec.enabled !== undefined && spec.enabled !== cur.enabled) {
        await s.write('toggle_highlighter', [Number(args[0]), spec.enabled], REF.spotlights)
      }
      if (s.dryRun) return planned(s)
      const errs = alerts(cmds)
      if (errs.length) throw new WebError(errs.join(' | '))
      return { ok: true, id: args[0] }
    }
    case 'enable':
    case 'disable': {
      need(args, 1, `spotlight ${sub} ID...`)
      args.forEach(numId)
      const on = sub === 'enable'
      if (args.length === 1) await s.write('toggle_highlighter', [Number(args[0]), on], REF.spotlights)
      else {
        experimental('bulk spotlight toggle: the web app sends an id array + 1/0; never captured')
        await s.write('toggle_highlighter', [args, on ? 1 : 0], REF.spotlights)
      }
      return s.dryRun ? planned(s) : { ok: true, ids: args, enabled: on }
    }
    case 'delete': {
      need(args, 1, 'spotlight delete ID... --yes')
      args.forEach(numId)
      requireYes(o, `delete spotlight(s) ${args.join(', ')}`)
      await s.write('delete_highlighter', [args, 'highlighters'], REF.spotlights)
      return s.dryRun ? planned(s) : { ok: true, ids: args, deleted: true }
    }
    default:
      throw new Error(`unknown spotlight subcommand: ${sub}\n\n${WEB_USAGE}`)
  }
}

// ---------------------------------------------------------------------------
// Subscriptions, folders, tags, monitoring feeds

const BULK_OPS: Record<string, string> = {
  enable: 'enable_subscriptions',
  disable: 'disable_subscriptions',
  unfollow: 'delete_subscriptions',
  unfile: 'subscription_add_to_root',
  'add-to-folder': 'subscription_add_to_folder_',
}

async function subCommand(s: WebSession, sub: string, args: string[], o: Opts): Promise<unknown> {
  if (sub === 'active') {
    need(args, 2, 'sub active SUB_ID on|off')
    const on = onOff(args[1], 'sub active SUB_ID')
    await s.write('change_subscription_status', [numId(args[0]), on], REF.feeds)
    return s.dryRun ? planned(s) : { ok: true, id: args[0], active: on }
  }
  if (sub === 'bulk') {
    need(args, 2, 'sub bulk OP SUB_ID...')
    const [op, ...ids] = args
    let type = BULK_OPS[op]
    if (!type) throw new Error(`bulk op must be one of: ${Object.keys(BULK_OPS).join(', ')}`)
    ids.forEach(numId)
    if (op === 'add-to-folder') type += String(numId(String(o.folder ?? '')))
    if (op === 'unfollow') requireYes(o, `unfollow ${ids.length} feed(s)`)
    experimental('bulk subscription operations: taken from the preferences page code; never captured')
    await s.write('do_bulk_subscription_operation', [ids, type], REF.feeds)
    return s.dryRun ? planned(s) : { ok: true, op: type, ids }
  }
  throw new Error(`unknown sub subcommand: ${sub}\n\n${WEB_USAGE}`)
}

async function folderCommand(s: WebSession, noun: 'folder' | 'tag', sub: string, args: string[], o: Opts): Promise<unknown> {
  if (sub === 'create') {
    need(args, 1, `${noun} create NAME`)
    experimental(`${noun} create: save_folder form partly guessed (never captured) — try --dry-run first`)
    const form: Record<string, unknown> = { folder_id: '0', folder_name: args.join(' '), folder_is_tag: noun === 'tag' ? '1' : '0' }
    if (noun === 'folder') {
      const feeds = String(o.feeds ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      if (!feeds.length) throw new Error('a folder needs at least one feed: --feeds SUB_ID,SUB_ID')
      feeds.forEach(numId)
      form.feed_id = feeds.join(',')
    }
    const cmds = await s.write('save_folder', [form], noun === 'tag' ? REF.tags : REF.folders)
    if (s.dryRun) return planned(s)
    const errs = alerts(cmds)
    if (errs.length) throw new WebError(errs.join(' | '))
    return { ok: true, name: form.folder_name }
  }
  if (sub === 'delete') {
    need(args, 1, `${noun} delete ID --yes`)
    requireYes(o, `delete ${noun} ${args[0]}`)
    experimental(`${noun} delete: argument order taken from the web app code; never captured`)
    const ctx = noun === 'tag' ? 'preferences_tags' : 'preferences_folders'
    await s.write('delete_folder', [numId(args[0]), noun === 'folder' && !!o.unfollow, ctx], noun === 'tag' ? REF.tags : REF.folders)
    return s.dryRun ? planned(s) : { ok: true, id: args[0], deleted: true }
  }
  throw new Error(`unknown ${noun} subcommand: ${sub}\n\n${WEB_USAGE}`)
}

async function monitorCommand(s: WebSession, sub: string, args: string[], o: Opts): Promise<unknown> {
  const spec = await readSpec(o)
  experimental('monitoring feeds: payload taken from the web app code; never captured')
  const term = String(spec.term ?? '')
  const common = {
    term,
    search_match: spec.search_match ?? (term ? 3 : 0),
    filter_type: spec.filter_type ?? 'public',
    filter_id: spec.filter_id ?? 0,
    search_feed_popularity: spec.search_feed_popularity ?? 0,
    search_filters: spec.search_filters ?? '',
    search_language: spec.search_language ?? '',
    ner_entities: spec.ner_entities === undefined ? '' : typeof spec.ner_entities === 'string' ? spec.ner_entities : JSON.stringify(spec.ner_entities),
  }
  if (!term && !common.ner_entities) throw new Error('monitoring feed needs "term" (advanced query) or "ner_entities"')
  if (sub === 'create') {
    if (!spec.title) throw new Error('monitoring feed needs a "title"')
    const post = {
      title: spec.title,
      ...common,
      folder_id: spec.folder_id ?? 0,
      new_folder_name: spec.new_folder_name ?? '',
      used_query_builder: 1,
      article_ids: [],
    }
    const cmds = await s.write('create_active_search', [post], REF.root)
    if (s.dryRun) return planned(s)
    const errs = alerts(cmds)
    if (errs.length) throw new WebError(errs.join(' | '))
    return { ok: true, title: spec.title }
  }
  if (sub === 'edit') {
    need(args, 1, 'monitor edit SUB_ID [--file F]')
    if (!spec.title) throw new Error('edit needs the feed "title"')
    const post = { id: numId(args[0]), type: 'subscription', from_builder: 1, title: spec.title, ...common }
    const cmds = await s.write('edit_active_search', [post, 'monitoring_feed_builder'], REF.root)
    if (s.dryRun) return planned(s)
    const errs = alerts(cmds)
    if (errs.length) throw new WebError(errs.join(' | '))
    return { ok: true, id: args[0] }
  }
  throw new Error(`unknown monitor subcommand: ${sub}\n\n${WEB_USAGE}`)
}

// ---------------------------------------------------------------------------
// Entry point

export async function webCommand(args: string[], o: Opts): Promise<unknown> {
  const [group, sub, ...rest] = args
  const s = new WebSession({ dryRun: !!o['dry-run'] })

  switch (group) {
    case undefined:
      return WEB_USAGE

    case 'login': {
      const parsed = parseCookieInput(await readStdin())
      const creds = {
        cookie: parsed.cookie,
        userAgent: o['user-agent'] || parsed.userAgent || DEFAULT_USER_AGENT,
        savedAt: new Date().toISOString(),
      }
      const names = cookieNames(creds.cookie)
      if (!names.includes('ssid') && !names.includes('al')) {
        process.stderr.write('warning: the cookie has neither "ssid" nor "al"; it may not be a logged-in session\n')
      }
      const { tags } = await probe(new WebSession({ credentials: creds }))
      saveWebCredentials(creds)
      return { ok: true, store: webStoreLocation(), cookieNames: names, tagsVisible: tags }
    }

    case 'logout':
      removeWebCredentials()
      return { ok: true }

    case 'status': {
      const c = loadWebCredentials()
      if (!c) return { loggedIn: false, store: webStoreLocation(), hint: LOGIN_HINT }
      const base = { store: webStoreLocation(), savedAt: c.savedAt, cookieNames: cookieNames(c.cookie), userAgent: c.userAgent }
      try {
        const { tags } = await probe(s)
        return { loggedIn: true, ...base, tagsVisible: tags }
      } catch (e) {
        if (e instanceof WebSessionExpired) return { loggedIn: false, ...base, error: e.message, hint: LOGIN_HINT }
        throw e
      }
    }

    case 'rules':
    case 'filters':
      return listRuleRows(s, group)

    case 'spotlights':
      return listSpotlights(s)

    case 'tags':
      return listTags(s)

    case 'sources': {
      const ac = await loadSources(s)
      return {
        subscriptions: ac.subscriptions
          .filter((x) => !o.type || x.type === o.type)
          .map((x) => ({
            id: x.id,
            type: x.type,
            title: x.title,
            url: x.rss_url,
            site: x.url,
            feedId: x.feed_id,
            ...(x.type === 'rss' ? { streamId: `feed/${x.rss_url}` } : {}),
          })),
        folders: o.type ? undefined : ac.folders.map((f) => ({ id: f.id, title: f.title })),
      }
    }

    case 'rule':
      return ruleCommand(s, 'rules', sub, rest, o)
    case 'filter':
      return ruleCommand(s, 'filters', sub, rest, o)
    case 'spotlight':
      return spotlightCommand(s, sub, rest, o)
    case 'sub':
      return subCommand(s, sub, rest, o)
    case 'folder':
    case 'tag':
      return folderCommand(s, group, sub, rest, o)
    case 'monitor':
      return monitorCommand(s, sub, rest, o)

    case 'output-feed': {
      const id = sub
      if (!id) throw new Error('usage: inoreader web output-feed ID on|off --kind tag|folder|system')
      const on = onOff(rest[0], 'output-feed ID')
      const kinds: Record<string, [string, string]> = {
        tag: ['preferences_tags', REF.tags],
        folder: ['preferences_folders', REF.folders],
        system: ['preferences_system_folders', REF.system],
      }
      const k = kinds[o.kind ?? '']
      if (!k) throw new Error('--kind must be tag, folder or system')
      await s.write('change_folder_visibility', [numId(id), on, k[0], null, null], k[1])
      return s.dryRun ? planned(s) : { ok: true, id, kind: o.kind, outputFeed: on }
    }

    case 'email-prefs': {
      experimental('read from the page bootstrap data (preference_sections); not confirmed to reflect saved values')
      const items = extractPreferenceItems(await s.page(REF.rules), 'emails_from_inoreader')
      if (!items) throw new WebError('could not find the "Emails from Inoreader" section in the page')
      return items.map((it) => ({
        key: it.name,
        label: it.label,
        on: it.value === true || it.value === 1 || it.value === '1',
        value: it.value ?? null,
      }))
    }

    case 'email-pref': {
      if (sub !== 'set') throw new Error('usage: inoreader web email-pref set KEY on|off')
      need(rest, 2, 'email-pref set KEY on|off')
      const [key, v] = rest
      if (!EMAIL_PREF_KEYS.includes(key)) throw new Error(`KEY must be one of: ${EMAIL_PREF_KEYS.join(', ')}`)
      experimental('save_user_pref(key, 1|0) is what the preferences autosave sends; never captured for these keys')
      await s.write('save_user_pref', [key, onOff(v, 'email-pref set KEY') ? 1 : 0], REF.prefs)
      return s.dryRun ? planned(s) : { ok: true, key, on: v === 'on' || v === 'true' || v === '1' }
    }

    case 'raw': {
      if (!sub) throw new Error('usage: inoreader web raw FN [JSON_ARG...]')
      const parsedArgs = rest.map((a) => {
        try {
          return JSON.parse(a)
        } catch {
          return a
        }
      })
      const cmds = await s.write(sub, parsedArgs, REF.root)
      return s.dryRun ? planned(s) : cmds
    }

    default:
      throw new Error(`unknown web command: ${group}\n\n${WEB_USAGE}`)
  }
}
