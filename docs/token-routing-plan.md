# Token Routing Plan

Status on 2026-04-25: the active product path is `oauth_env` plus
relaunch/resume at a safe boundary. The earlier generic HTTP proxy approach was
tested, failed against the real Anthropic OAuth upstream, and has been removed
from runnable ccswap code.

Detailed proxy failure evidence lives in
`docs/proxy-oauth-forwarding-failure.md`. The current implementation plan lives
in `docs/oauth-env-relaunch-solution.md` and
`docs/next-task-safe-relaunch.md`.

## Current Decision

Supported auth modes:

- `keychain_copy`: stable default. Copies the selected ccswap credential into
  Claude Code's standard credential slot before launch.
- `oauth_env`: experimental no-Keychain path. Reads the selected saved
  credential and injects `CLAUDE_CODE_OAUTH_TOKEN` only into the spawned Claude
  process.

Removed auth mode:

- `proxy`: removed after generic OAuth forwarding returned `401 Invalid
  authentication credentials` against the real Anthropic upstream. It should
  not appear in config as a supported value, CLI help, session launch code, or
  active tests.

Legacy configs that still say `"auth_mode": "proxy"` are normalized back to
`keychain_copy`.

## Why Proxy Was Closed

The desired no-relaunch proxy design was:

```text
Claude Code -> localhost proxy -> replace Authorization per request
```

Mechanical pieces worked during the experiment:

- Claude Code could be pointed at `ANTHROPIC_BASE_URL`.
- The proxy could see `HEAD /` and `POST /v1/messages?beta=true`.
- It could preserve method, path, query, body, and Anthropic headers.
- It could stream fake upstream SSE responses.
- It could swap bearer tokens and route by `x-claude-code-session-id` against
  fake upstreams.

The real upstream boundary failed:

```text
CLAUDE_CODE_OAUTH_TOKEN=<token> claude -p "Return exactly ok" -> ok
generic fetch/curl/proxy forwarding with the same visible token/request -> 401
```

That failure was reproduced for both token sources:

- the saved `claudeAiOauth.accessToken` from `claude auth login`
- a long-lived token produced by `claude setup-token`

Therefore ccswap should not keep proxy token swapping as a production or
diagnostic CLI path unless Claude Code or Anthropic later documents a supported
generic OAuth forwarding contract.

## Active Product Path

The current swap mechanism stays process-boundary based:

```text
ccswap launcher -> Claude Code child process
                -> selected account auth per launch
                -> usage watcher
                -> safe-boundary relaunch with --resume
```

For `oauth_env`, each new Claude child process receives the selected account's
token through `CLAUDE_CODE_OAUTH_TOKEN`. ccswap still deletes ambient
`CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, and `ANTHROPIC_API_BASE_URL` before launch so accidental
outer-shell auth does not leak into the managed child process.

For `keychain_copy`, ccswap activates the selected account credential in the
standard Claude Code credential slot, then launches Claude with a scrubbed
environment.

## Swap Semantics

Hard limit:

1. Detect a limit message in Claude output.
2. Confirm the selected account is exhausted through usage data.
3. Pick the next eligible account.
4. Relaunch Claude with the next account.
5. Resume the same session with `--resume <session-id>`.
6. Replay according to the configured replay mode.

Proactive threshold:

1. Detect usage at or above `proactive_swap_threshold_pct`.
2. Mark runtime state as `swap_pending`.
3. Wait for a quiet terminal-activity boundary, or a max-wait fallback.
4. Relaunch Claude with the next account.
5. Resume the same session with `--resume <session-id>`.
6. Send a short `Continue.` prompt instead of replaying the previous user
   prompt.

The proactive path is the answer to the terminal-continuity requirement: after
the new Claude process starts, it receives an explicit continuation prompt so
the AI has a reason to keep working in the resumed chat session.

## Implemented

- `auth_mode` supports only `keychain_copy` and `oauth_env`.
- `proxy` normalizes to `keychain_copy` for legacy config compatibility.
- `ccswap token-probe <account> --infer` remains available for direct
  `CLAUDE_CODE_OAUTH_TOKEN` validation.
- Phase 1 safe relaunch is implemented for wrapper mode.
- Proactive relaunches force continue replay and append `Continue.`.
- Runtime state records pending and safe-to-restart fields.
- Statusline usage capture records usage for the launch account only; the old
  proxy runtime active-account routing hook has been removed.
- Proxy command, proxy tests, and proxy session branches have been removed from
  active code.

## Later Work

- Add transcript JSONL or hook-aware safe-boundary detection so swaps avoid
  tool-use windows more reliably than terminal quiet time alone.
- Done: add a plain `claude` connector so users can type plain `claude` while
  ccswap owns account selection and relaunch/resume behavior.
- Optional later hardening: move the launcher into a separate daemon/IPC layer.
- Add account locking or per-session policy before managing multiple
  simultaneous Claude sessions.

## Test Expectations

Automated checks should cover:

- `buildClaudeEnv()` scrubs ambient Claude/Anthropic auth.
- `buildClaudeLaunchAuth()` injects only `CLAUDE_CODE_OAUTH_TOKEN` for
  `oauth_env`.
- legacy `auth_mode: "proxy"` loads as `keychain_copy`.
- no active CLI command imports or exposes `ccswap proxy`.
- proactive swap waits for a quiet boundary.
- proactive relaunch uses `--resume <session-id> Continue.` without replaying
  the previous prompt.
- hard-limit relaunch keeps existing replay behavior.
- usage capture no longer accepts or depends on proxy runtime routing.

Manual checks should cover:

- `ccswap token-probe <account> --infer`
- `auth_mode: "oauth_env"` with `ccswap claude -p "Return exactly ok"`
- a forced low-threshold proactive swap, confirming the resumed TUI receives
  `Continue.`
- no OAuth token appears in terminal output or logs

## Closed Research Notes

The removed proxy work established useful boundaries:

- Claude Code accepts the same token through its own process-auth path.
- Generic HTTP clients do not become equivalent to Claude Code simply by
  replaying visible headers/body and replacing `Authorization`.
- Replacing visible billing marker metadata did not fix real-upstream auth.
- `claude setup-token` did not produce a token class accepted by generic
  forwarding.

Do not reopen this path by reimplementing the same token-only proxy loop. A
future attempt needs a new upstream-supported contract, not another variant of
the same replay.
