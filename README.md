# ccswap

Multi-account Claude Code switcher with auto-swap on limit.

`ccswap` manages multiple Claude subscription logins, wraps `claude` in a PTY,
watches usage and "limit reached" style messages, and rotates to the next
healthy account automatically — resuming the same Claude session.

## Status

Rewritten in TypeScript + Ink. Cross-platform: macOS, Linux, Windows (native).

The original Python implementation (`ccswap.py`, `ccswap_runtime.py`,
`ccswap_usage.py`) still lives in this directory for reference but is not what
the `ccswap` command invokes after this rewrite.

## Requirements

- Node.js ≥ 20
- `claude` on PATH (installed natively or via `npm i -g @anthropic-ai/claude-code`)

## Install (development)

```sh
pnpm install
pnpm build
# link globally for ad-hoc use:
npm link
```

## CLI

```sh
ccswap                       # open the TUI dashboard
ccswap init                  # create ~/.config/ccswap
ccswap account add <name>    # add an account row (legacy; prefer dashboard `a`)
ccswap account list
ccswap account remove <name>
ccswap login <name>          # re-run `claude auth login` for an existing account
ccswap use <name>            # set active account (name is the OAuth email for new accounts)
ccswap run -- <claude-args>  # run claude through ccswap with auto-swap
ccswap claude <claude-args>  # shorthand for the above
```

## Dashboard keys

### Accounts screen
- `j` / `k` / arrows — move selection
- `Enter` — set active account
- `a` — add account: launches `claude auth login`, captures the OAuth
  credential, and registers the account under the login's email address
  (`chenjing@gmail.com`). Collisions get a numeric suffix. Dashboard returns
  automatically when the login flow ends (success or cancel).
- `e` — edit selected account (toggle auto-swap / delete)
- `l` — re-run `claude auth login` for the selected account (use when the
  saved token has expired). Email is refreshed from `~/.claude.json` on
  every successful login, so legacy short-named rows pick up their email
  after one re-login.
- `Tab` — switch to Sessions
- `q` / `Ctrl-C` — quit the dashboard

During any `claude auth login` run, press `Ctrl-C` to cancel — ccswap
forwards the signal and force-kills the subprocess after 1.5s if it doesn't
exit on its own.

### Sessions screen
- `j` / `k` / arrows — move selection
- `m` — cycle replay mode (last prompt / continue / custom)
- `p` — set custom replay prompt
- `Tab` — switch to Accounts

## How it works

Per-account state lives entirely in the OS credential store via
`@napi-rs/keyring` — ccswap does not override `CLAUDE_CONFIG_DIR`, so all
accounts share `~/.claude` and skip Claude Code's first-run onboarding after
the first login. Only the OAuth credential rotates per account:

- macOS → Keychain
- Linux → Secret Service (libsecret)
- Windows → Credential Manager

When `ccswap claude` spawns `claude`, it injects a `--settings` file that
wraps Claude Code's `statusLine` command so ccswap can cache live usage
snapshots. ccswap tracks the active session and last submitted prompt by
watching Claude Code's shared transcript files under `~/.claude/projects`.
Output is scanned for limit patterns in real time.

When a limit is confirmed:

1. Current account is marked attempted
2. Next eligible account (auto-swap on, not attempted) is picked
3. Claude is relaunched with `--resume <session-id>` and (depending on replay
   mode) the last prompt appended, so the conversation continues.

By default, ccswap also watches Claude Code's statusline usage snapshot and
switches accounts before the hard limit once either the five-hour or seven-day
bucket reaches 95%. This proactive swap resumes the same session without
replaying the last prompt, so the next prompt starts on the fresh account. Set
`proactive_swap_threshold_pct` to another percentage, or `null` to disable it.

## Paths

- `~/.config/ccswap/config.json` — accounts + settings
- `~/.config/ccswap/state.json` — active / last account
- `~/.config/ccswap/runtime/` — per-run session state + hook settings
- `~/.config/ccswap/usage-cache/` — per-account usage snapshots

On Windows the root is `%APPDATA%\ccswap`.

## Config file compatibility

The JSON field names (`accounts`, `claude_bin`, `replay_mode`, `custom_prompt`,
`proactive_swap_threshold_pct`, `keychain_service`, `keychain_account`,
`auto_swap`) are used by the TypeScript implementation. Existing configs that
still contain legacy `claude_config_dir` fields continue to load, but ccswap no
longer creates or writes per-account Claude config folders. Legacy `enabled` is
read as `auto_swap`. The TS version adds a nullable `email` field per account,
populated from `~/.claude.json`'s `oauthAccount` on successful login.

## Tests

```sh
pnpm typecheck
pnpm build
pnpm test   # vitest: unit + PTY integration + Ink rendering
```

## Release

```sh
# bump version in package.json, then
pnpm run prepublishOnly   # typecheck + test + build
npm publish               # requires npm login
```

A Homebrew formula template lives at `packaging/homebrew/ccswap.rb`. After
publishing to npm, copy it into your `homebrew-tap` repo under `Formula/`,
update the `url` and `sha256`, and users can then
`brew install chenjingdev/tap/ccswap`.

## CI

GitHub Actions runs `typecheck`, `build`, `test` on macOS, Linux, Windows on
Node 20 and 22 (`.github/workflows/ci.yml`).
