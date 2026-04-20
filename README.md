# ccswap

Multi-account Claude Code switcher with auto-swap on limit.

`ccswap` manages multiple Claude subscription logins, wraps `claude` in a PTY,
watches for "limit reached" style messages, and rotates to the next healthy
account automatically — resuming the same Claude session with your last prompt.

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
ccswap account add <name>    # add an account row
ccswap account list
ccswap account rename <old> <new>
ccswap account remove <name>
ccswap login <name>          # run `claude auth login` and save the login
ccswap use <name>            # set active account
ccswap run -- <claude-args>  # run claude through ccswap with auto-swap
ccswap claude <claude-args>  # shorthand for the above
```

## Dashboard keys

### Accounts screen
- `j` / `k` / arrows — move selection
- `Enter` — set active account
- `a` — add account (modal)
- `r` — rename selected account
- `d` — delete selected account
- `l` — run `claude auth login` for selected account
- `Space` — toggle auto-swap for selected account
- `Tab` — switch to Sessions
- `q` / `Ctrl-C` — quit

### Sessions screen
- `j` / `k` / arrows — move selection
- `m` — cycle replay mode (last prompt / continue / custom)
- `p` — set custom replay prompt
- `Tab` — switch to Accounts

## How it works

Each account owns its own `CLAUDE_CONFIG_DIR` under
`~/.config/ccswap/accounts/<name>/claude`. The saved Claude login is kept in
the OS credential store via `@napi-rs/keyring`:

- macOS → Keychain
- Linux → Secret Service (libsecret)
- Windows → Credential Manager

When `ccswap claude` spawns `claude`, it injects a `--settings` file that
registers `SessionStart` and `UserPromptSubmit` hooks. Those hooks call back
into `ccswap hook ...` to record the Claude session id and the last submitted
prompt. Output is scanned for limit patterns in real time.

When a limit is confirmed:

1. Current account is marked attempted
2. Next eligible account (auto-swap on, not attempted) is picked
3. Claude is relaunched with `--resume <session-id>` and (depending on replay
   mode) the last prompt appended, so the conversation continues.

## Paths

- `~/.config/ccswap/config.json` — accounts + settings
- `~/.config/ccswap/state.json` — active / last account
- `~/.config/ccswap/runtime/` — per-run session state + hook settings
- `~/.config/ccswap/accounts/<name>/claude/` — per-account Claude config dir

On Windows the root is `%APPDATA%\ccswap`.

## Config file compatibility

The JSON field names (`accounts`, `claude_bin`, `replay_mode`, `custom_prompt`,
`keychain_service`, `keychain_account`, `auto_swap`, `claude_config_dir`) are
compatible with the legacy Python implementation, so an existing
`~/.config/ccswap/config.json` loads into the TS version with no migration.
Legacy `enabled` is read as `auto_swap`.

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
