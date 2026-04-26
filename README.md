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
ccswap account add <name>    # add an empty account row
ccswap account list
ccswap account remove <name>
ccswap login <name>          # re-run `claude auth login` for an existing account
ccswap use <name>            # set the default account for new sessions
ccswap token-probe <name>    # experimental: try per-process OAuth token auth
ccswap connect               # manually connect/repair plain `claude`
ccswap status                # show dashboard + plain `claude` connection status
ccswap disconnect            # restore the previous plain `claude` command
ccswap run -- <claude-args>  # run claude through ccswap with auto-swap
ccswap claude <claude-args>  # shorthand for the above
```

## Dashboard keys

### Accounts screen
- `j` / `k` / arrows — move selection
- `Enter` — set the default account for new sessions
- `a` — add account: launches `claude auth login`, captures the OAuth
  credential, and registers the account under the login's email address
  (`chenjing@gmail.com`). Collisions get a numeric suffix. Dashboard returns
  automatically when the login flow ends (success or cancel).
- `e` — edit selected account (toggle auto-swap / delete)
- `t` — set the proactive auto-swap threshold (`5h` usage only)
- `l` — re-run `claude auth login` for the selected account (use when the
  saved token has expired). Email is refreshed from `~/.claude.json` on
  every successful login.
- `Tab` — switch to Sessions
- `q` / `Ctrl-C` — quit the dashboard

During any `claude auth login` run, press `Ctrl-C` to cancel — ccswap
forwards the signal and force-kills the subprocess after 1.5s if it doesn't
exit on its own.

### Sessions screen
- `j` / `k` / arrows — move selection
- `s` — request an account switch for the selected live session
- `m` — cycle replay mode (last prompt / continue / custom). Default is
  continue-only.
- `p` — set custom replay prompt
- `Tab` — switch to Accounts

## How it works

Per-account state lives entirely in the OS credential store via
`@napi-rs/keyring` — ccswap does not override `CLAUDE_CONFIG_DIR`, so all
accounts share `~/.claude` and skip Claude Code's first-run onboarding after
the first login. Account switching is credential-based rather than
environment-folder-based:

- macOS → Keychain
- Linux → Secret Service (libsecret)
- Windows → Credential Manager

In the default `keychain_copy` mode, ccswap activates an account by copying the
selected saved credential into Claude Code's standard credential slot before
launch. In experimental `oauth_env` mode, it leaves that standard slot alone
and injects `CLAUDE_CODE_OAUTH_TOKEN` only into the spawned Claude process.

When `ccswap claude` spawns `claude`, it injects a `--settings` file that
wraps Claude Code's `statusLine` command so ccswap can cache live usage
snapshots. ccswap tracks the active session and last submitted prompt by
watching Claude Code's shared transcript files under `~/.claude/projects`.
Output is scanned for limit patterns in real time.

For the normal day-to-day flow, keep `ccswap` open as the dashboard. On
startup, the dashboard safely auto-connects plain `claude`
when it can wrap the current real Claude command without overwriting an
existing backup or hiding a PATH conflict. After that, plain `claude ...`
behaves like `ccswap claude ...` while ccswap still launches the real Claude
binary internally.

The dashboard automatically repairs the plain `claude` connection whenever it
can do so safely. `ccswap connect` remains an advanced repair command for
install or PATH recovery. It installs the same tiny command connector at a safe
user-local `claude` path, moves any previous command at that path to
`claude.ccswap-real`, and saves the resolved real Claude binary in
`config.json`. The dashboard shows whether this connection is active, whether
the current shell resolves `claude` to that connector first, and records a
heartbeat while it is running. If a shell resolves `claude` from an app bundle
before the user-local connector, put `~/.local/bin` earlier in PATH. Set
`CCSWAP_BYPASS=1` to bypass the connector for one command.

When a limit is confirmed:

1. Current account is marked attempted
2. Next eligible account (auto-swap on, not attempted) is picked
3. Claude is relaunched with `--resume <session-id>` and (depending on replay
   mode) the last prompt appended, so the conversation continues.

By default, ccswap also watches Claude Code's statusline usage snapshot and
switches accounts before the hard limit once the five-hour bucket reaches 95%.
This proactive swap is now pending-first: ccswap records
the pending swap, waits for a short quiet terminal-activity window, then
relaunches Claude with `--resume <session-id>` and a short `Continue.` prompt
instead of replaying the last prompt. Set `proactive_swap_threshold_pct` to
another percentage, or `null` to disable it. Threshold changes made from the
dashboard are picked up by running ccswap sessions. If a selected live session
already has an automatic proactive swap pending and you press `s`, the manual
session switch takes priority and clears the proactive pending marker. If all
eligible accounts are already at or above the threshold, ccswap leaves the
current Claude session running and records a reset wait instead of exiting.
It schedules the next check for the earliest known five-hour reset time plus a
small buffer, refreshes usage once at that time, and only swaps if another
account is actually below the threshold. With a single account, this means the
session simply stays alive until that account's five-hour window resets.

`auth_mode` defaults to `keychain_copy`, which keeps the stable credential-copy
activation behavior. Set it to `oauth_env` only for experiments: ccswap will
read the selected account credential and inject `CLAUDE_CODE_OAUTH_TOKEN` into
the Claude child process without mutating Claude Code's standard credential.
Use `ccswap token-probe <name> --infer` before enabling it.

`auth_mode: "proxy"` was tested and removed from the runnable product surface.
The proxy experiment could capture Claude's request shape, preserve
headers/body, stream fake upstream SSE responses, and swap bearer tokens
against fake upstreams. However, Claude Code's `CLAUDE_CODE_OAUTH_TOKEN`
requests are accepted by Claude's own client path while Anthropic rejects the
same OAuth request when it is re-sent by a generic HTTP proxy (`401 Invalid
authentication credentials`). Because of that upstream behavior, ccswap no
longer ships the proxy CLI or proxy auth mode. Use `oauth_env` for the
no-Keychain experimental path, or `keychain_copy` for the stable default.
See `docs/proxy-oauth-forwarding-failure.md` for the archived failure analysis
and the exact tested boundaries.

The supported direction is documented in
`docs/oauth-env-relaunch-solution.md`: use `oauth_env` for per-process account
tokens, then relaunch/resume Claude at a quiet boundary instead of trying to
swap login OAuth tokens inside the HTTP proxy. The one remaining proxy-side
checkpoint, `claude setup-token`, was tested on 2026-04-25: direct Claude Code
auth worked, but generic forwarding still returned `401`, so proxy mode was
removed instead of kept as an enabled path.

### Setup-token proxy checkpoint

The failed real-upstream proxy experiments used the access token saved by
`claude auth login` in ccswap's stored credential. A separate experiment was
run with a token produced by:

```sh
claude setup-token
```

That token worked when used only in local env for Claude Code:

```sh
CLAUDE_CODE_OAUTH_TOKEN="$SETUP_TOKEN" claude -p "Return exactly ok"
```

But the same setup-token failed through generic forwarding to the real
Anthropic upstream:

```text
401 Invalid authentication credentials
```

That closes proxy mode for production unless Claude Code or Anthropic later
documents a supported generic OAuth forwarding contract.

The Phase 1 safe relaunch implementation is tracked in
`docs/next-task-safe-relaunch.md`. It covers wrapper/connector mode. The
dashboard shows account/usage state and keeps session replay settings in the
Sessions screen; transcript-aware boundaries are still a future hardening
layer.

## Paths

- `~/.config/ccswap/config.json` — accounts + settings
- `~/.config/ccswap/state.json` — default / last default account
- `~/.config/ccswap/runtime/` — internal per-run restart state + hook settings
- `~/.config/ccswap/usage-cache/` — per-account usage snapshots

On Windows the root is `%APPDATA%\ccswap`.

## Config File

The JSON field names (`accounts`, `claude_bin`, `replay_mode`, `custom_prompt`,
`proactive_swap_threshold_pct`, `auth_mode`, `auth_source`, `keychain_service`,
`keychain_account`, `auto_swap`) are used by the TypeScript implementation.
Account rows are credential-backed. Rows that still contain
`claude_config_dir`, or rows without `auth_source: "credential"`, are not
loaded because ccswap no longer supports per-account Claude config folders.
The nullable `email` field is populated from `~/.claude.json`'s `oauthAccount`
on successful login.

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
