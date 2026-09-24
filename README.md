# inoreader-cli

A small command-line client for the [Inoreader API](https://www.inoreader.com/developers/),
built on [`inoreader-js`](https://github.com/mogita/inoreader-js). Every command prints JSON,
so it works well for scripts and AI agents.

- OAuth 2.0 login with a local callback. Tokens refresh automatically.
- On macOS, credentials go in the **Keychain**. Elsewhere they go in a `0600` file.
- A **local article cache** plus **API-budget tracking**. The API allows about 100 read
  and 100 write calls per day, so you sync once and then analyse offline.
- A **web-session mode** for rules, filters, spotlights and a few settings the API lacks.
- Batch writes: a single call can tag, star or mark read up to 250 articles.

## Requirements

- Node.js ≥ 22.18. It runs the TypeScript directly, with no build step. The launcher
  falls back to [nvm](https://github.com/nvm-sh/nvm) if `node` isn't on `PATH`.
- An Inoreader account with API access. Personal use requires a **Pro** plan.
- An Inoreader developer app. Register one at <https://www.inoreader.com/developers/register-app>
  with the redirect URI `http://localhost:8765/callback`, or set `INOREADER_REDIRECT_URI`
  to match whatever URI you registered.

## Install

```bash
git clone https://github.com/vladola/inoreader-cli.git
cd inoreader-cli
npm ci --ignore-scripts
ln -s "$PWD/bin/inoreader" ~/.local/bin/inoreader   # or: npm link
```

## Log in (once)

App credentials are only needed at login. Afterwards they're stored with the tokens.

```bash
# from env vars
INOREADER_APP_ID=... INOREADER_APP_KEY=... inoreader auth login

# or from a 1Password item (App ID in `username`, App key in `credential`)
inoreader auth login --op "op://<vault>/<item>"

inoreader auth status
```

## Usage

```bash
inoreader user
inoreader subs                                 # subscriptions + folders
inoreader folders                              # folders/tags with unread counts
inoreader counts
inoreader list starred -n 10
inoreader list feed:https://example.com/rss --unread --since 2d --full
inoreader get <id>                             # full article text
inoreader star <id>
inoreader tag Newsletters <id> <id>
inoreader subscribe https://example.com/feed --folder Tech
inoreader raw GET /reader/api/0/preference/list
inoreader --help
```

### Working within the rate limit

```bash
inoreader sync <stream> --pages 5              # ≤5 read calls, caches up to 500 articles
inoreader cached --feed <feed> --group author  # who sends what (no API calls)
inoreader cached --author "Morning Brew" --untagged --ids | inoreader tag Finance -
inoreader rate                                 # budget as of the last call (free)
```

After each API call, the remaining budget is printed to stderr. `sync` stops as soon as a
page has no new articles, unless you pass `--deep`.

Some things can't be done through the public API: rules, filters, spotlights and
active searches. For those, see [Web session](#web-session-rules-filters-spotlights).

## Web session (rules, filters, spotlights)

The public API has no endpoints for rules, filters, spotlights or some settings. For those,
`inoreader web …` talks to the same (undocumented) endpoint the Inoreader web app uses,
authenticated with your browser's session cookie.

> **Unofficial.** This is not a supported API. It can change or break without notice, and
> automated use may be against Inoreader's terms. Use it for your own account, sparingly.
> Commands whose request format was taken from the web app's code but never observed on the
> wire print `{"experimental":true,…}` on stderr. Try them with `--dry-run` first.

### Log in

1. Open <https://www.inoreader.com> in your browser, logged in.
2. Open DevTools → **Network**, then click around (e.g. open *Automation → Rules*).
3. Right-click any request whose URL contains `?xjxfun=` → **Copy → Copy as cURL**.
4. Paste it into the CLI via stdin (it only accepts stdin, so the cookie never lands in your
   shell history or `ps`):

```bash
pbpaste | inoreader web login        # also accepts a bare "cookie: ..." header value
inoreader web status                  # cheap check; never prints the cookie
inoreader web logout
```

The cookie is stored like the OAuth tokens (Keychain account `<profile>:web`, or
`<profile>.web.json` with `INOREADER_STORE=file`). **Treat it like a password.** It grants
full access to your account. The session's "remember me" cookie lasts about a month; when it
expires, commands fail with `WebSessionExpired`, so repeat the steps above.

Web calls don't count against the API's daily quota. They are paced at least 0.75 s apart
(`INOREADER_WEB_DELAY_MS`) to stay polite.

### Commands

```bash
inoreader web rules                     # id, name, enabled, matches today, trigger
inoreader web filters
inoreader web spotlights
inoreader web tags                      # tag ids for rule specs
inoreader web sources --type rss        # subscription/folder ids (also keyword, user_newsletter)
inoreader web rule get 123              # decoded, with raw codes alongside (--raw: as stored)
inoreader web rule export > rules.json  # everything, for review/diff
inoreader web rule create --file rule.json
echo '{"name":"New name"}' | inoreader web rule update 123   # partial specs are merged
inoreader web rule disable 123
inoreader web rule run 123              # apply to recent existing articles (Plus/Pro)
inoreader web rule delete 123 --yes
inoreader web filter create --file filter.json
echo '{"name":"Topic","terms":["alpha",{"term":"Beta","caseSensitive":true}],"color":3}' \
  | inoreader web spotlight create
inoreader web spotlight disable 11 12
inoreader web sub active 456 off        # pause a feed
inoreader web email-prefs               # "Emails from Inoreader" checkboxes
inoreader web email-pref set top_stories_reminder off
inoreader web --help                    # everything else
```

Every write takes `--dry-run`, which prints the exact call(s), decoded, and sends nothing.
Deletes need `--yes`.

### Rule spec

```json
{
  "name": "Release notes",
  "trigger": { "type": "folder", "id": "1234" },
  "match": "any",
  "wholeWords": true,
  "conditions": [
    { "field": "title", "op": "contains", "text": "release" },
    { "field": "url", "op": "regex", "text": "/changelog|releases/i" }
  ],
  "actions": [
    { "type": "tag", "tag": "releases" },
    { "type": "read" }
  ]
}
```

- **trigger.type:** `account` (no id), `folder`, `feed`, `tag`, `read_later`, `saved_web_page`,
  `rule_matched` (id = another rule), `team_channel`, `intelligence_report`, `upload`.
- **match:** `all`, `any`, or `everything` (no conditions).
- **field:** `title_or_content`, `title`, `content`, `author`, `url`, `url_path`,
  `has_attachments`, `has_pictures`, `has_video`, `no_pictures`, `no_video`, `categories`,
  `language` (text = language code), `mention`.
- **op:** `contains`, `not_contains`, `is`, `is_not`, `begins_with`, `ends_with`, `regex`,
  `not_regex`. Wrap regexes in slashes.
- **actions:**
  - `tag` (`tag`: a name or id; unknown names create the tag)
  - `read`, `read_later` (alias `star`)
  - `email` (`to`, optional `template`), `webhook` (`url`), `push` (optional `prefix`),
    `note` (`text`), `desktop_alert`
  - `summary`, `translate`, `team_channel`, and the send-to services (`instapaper`,
    `evernote`, `onenote`, `dropbox`, `google_drive`, `raindrop`)
  - Any action also takes a raw `params` string.
- **Raw codes:** numeric codes work anywhere a name does. `rule get` output can be edited and
  fed back to `rule update`.
- **Content filters:** `"trigger": {"type": "feed" | "folder", "id": …}`, plus
  `"mode": "remove" | "keep"` and conditions.
- **Duplicate filters (experimental):** `"kind": "duplicate_filter"`, plus
  `"dedup": {"method": "url" | "title_exact" | "title_fuzzy", "precision": "loose" | "moderate" | "strict", "period": "6h" … "1w" … "1m"}`.

## Configuration

| Env var | Purpose |
|---|---|
| `INOREADER_APP_ID`, `INOREADER_APP_KEY` | App credentials for `auth login` |
| `INOREADER_OP_ITEM` | Default 1Password item reference for `auth login` |
| `INOREADER_REDIRECT_URI` | OAuth redirect (default `http://localhost:8765/callback`) |
| `INOREADER_PROFILE` | Use several accounts side by side (default `default`) |
| `INOREADER_STORE=file` | Store credentials in a file even on macOS |
| `INOREADER_CREDENTIALS_FILE` | File path for the credential store |
| `INOREADER_WEB_DELAY_MS` | Minimum gap between web-session calls (default 750) |
| `INOREADER_CACHE_TEXT_CHARS` | Characters of article text kept in the cache (default 4000) |

The cache lives in `~/.cache/inoreader-cli/<profile>/`.

## License

MIT
