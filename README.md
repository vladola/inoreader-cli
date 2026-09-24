# inoreader-cli

A small command-line client for the [Inoreader API](https://www.inoreader.com/developers/),
built on [`inoreader-js`](https://github.com/mogita/inoreader-js). Every command prints JSON,
so it works well for scripts and AI agents.

- OAuth 2.0 login with a local callback. Tokens refresh automatically.
- On macOS, credentials go in the **Keychain**. Elsewhere they go in a `0600` file.
- A **local article cache** plus **API-budget tracking**. The API allows about 100 read
  and 100 write calls per day, so you sync once and then analyse offline.
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
active searches. Set those up in the Inoreader web UI.

## Configuration

| Env var | Purpose |
|---|---|
| `INOREADER_APP_ID`, `INOREADER_APP_KEY` | App credentials for `auth login` |
| `INOREADER_OP_ITEM` | Default 1Password item reference for `auth login` |
| `INOREADER_REDIRECT_URI` | OAuth redirect (default `http://localhost:8765/callback`) |
| `INOREADER_PROFILE` | Use several accounts side by side (default `default`) |
| `INOREADER_STORE=file` | Store credentials in a file even on macOS |
| `INOREADER_CREDENTIALS_FILE` | File path for the credential store |
| `INOREADER_CACHE_TEXT_CHARS` | Characters of article text kept in the cache (default 4000) |

The cache lives in `~/.cache/inoreader-cli/<profile>/`.

## License

MIT
