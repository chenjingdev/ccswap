# OAuth Env Relaunch Solution

This is the replacement plan after `auth_mode: "proxy"` failed against the
real Anthropic OAuth upstream. The short version:

- Do not try to swap Claude OAuth tokens inside a generic HTTP proxy for
  production.
- Use `auth_mode: "oauth_env"` as the no-Keychain auth path because direct
  Claude Code child processes accept `CLAUDE_CODE_OAUTH_TOKEN`.
- Keep account swaps relaunch/resume based, but move the relaunch to a quiet
  boundary so the user does not have to retype the prompt and tool work is not
  interrupted mid-flight.
- Let the always-on dashboard own the plain `claude` connection experience so
  the user can type plain `claude`.

The proxy failure details live in
`docs/proxy-oauth-forwarding-failure.md`.

Important caveat resolved on 2026-04-25: the later setup-token proxy check was
run. A long-lived `claude setup-token` token worked for direct Claude Code
child-process auth, but generic fetch/curl/proxy forwarding to the real
Anthropic upstream still returned `401`. `oauth_env` plus safe relaunch is the
current production path.

Implementation status on 2026-04-25:

- Phase 1 wrapper-mode safe relaunch is implemented.
- Proactive swaps are pending-first and wait for terminal quiet time or a max
  wait before gracefully exiting Claude.
- Proactive relaunches keep `--resume <session-id>` and send a short
  `Continue.` prompt instead of replaying the last prompt.
- Proxy implementation/CLI code was removed after the real-upstream failure.
  The failure evidence remains archived in
  `docs/proxy-oauth-forwarding-failure.md`.
- Plain `claude` can route through ccswap after the dashboard auto-connects it
  when safe, or after manual repair with `ccswap connect`.
- The dashboard records its own heartbeat and shows whether plain `claude` is
  connected. A separate daemon/IPC layer is optional later hardening;
  transcript/hook-aware boundaries are still later work.

## Decision

The production direction is:

```text
Plain claude connector -> ccswap launcher -> Claude Code child process
                                        -> CLAUDE_CODE_OAUTH_TOKEN per launch
                                        -> usage watcher
                                        -> safe-boundary relaunch with --resume
```

The production direction is not:

```text
Claude Code -> local HTTP proxy -> replace Authorization per request
```

The reason is that direct Claude Code with `CLAUDE_CODE_OAUTH_TOKEN` works, but
Node fetch, curl, and the ccswap proxy cannot replay the same visible OAuth
request to real Anthropic. They receive `401 Invalid authentication
credentials`.

## User Experience Target

The user-facing target stays the same:

- The dashboard app can stay open in the background.
- The user can type `claude` without thinking about ccswap.
- ccswap chooses the first account and watches usage.
- At roughly the proactive threshold, for example 95%, ccswap prepares the next
  account.
- ccswap waits for a safe boundary.
- ccswap relaunches Claude Code with the next account's
  `CLAUDE_CODE_OAUTH_TOKEN`.
- ccswap resumes the same session with `--resume <session-id>`.
- For proactive swaps, ccswap sends a continuation prompt and does not replay
  the last prompt.

This does not give true in-process token replacement, but it avoids the part
that proved unsupported and keeps the visible workflow close to uninterrupted.

## Why This Can Work

The verified working surface is the Claude Code process boundary:

```sh
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude -p "Return exactly ok"
```

That means every new Claude child process can be launched with a different
account token without copying credentials into Claude Code's standard Keychain
slot.

The existing ccswap wrapper already has most of the hard pieces:

- selected-account launch
- usage snapshot capture
- proactive usage threshold detection
- hard-limit text detection
- transcript/session discovery
- `--resume <session-id>` relaunch
- continuation prompt without last-prompt replay for proactive swaps

The first safe-timing layer now exists. The dashboard-owned plain `claude`
connection now exists. The remaining production-grade hardening is stronger
transcript/hook-aware boundary signals and optional daemon/IPC ownership.

## Swap Semantics

There are two different swap paths.

Hard limit swap:

- Triggered after Claude output shows a limit message and usage confirms the
  selected account is exhausted.
- Relaunch with the next account.
- Resume the same session.
- Keep the existing replay behavior because the previous prompt may not have
  finished.

Proactive swap:

- Triggered when usage reaches the configured threshold.
- Mark the session as `swap_pending`.
- Do not kill Claude immediately if it is currently busy.
- Wait until the current response or tool cycle reaches a quiet boundary.
- Relaunch with the next account.
- Resume the same session.
- Send a continuation prompt, not the last prompt.

The proactive path is the main answer to the "do not retype the prompt" goal.
It does not need prompt replay because the swap happens before the next user
prompt or next model turn that needs the fresh account.

## Safe Boundary Model

Start conservative and evolve it in layers.

Phase 1 boundary:

- Detect proactive threshold.
- Mark `swap_pending`.
- Wait for Claude to become idle by terminal activity heuristics:
  - no output for a short quiet window
  - no recent stdin bytes from the user
  - Claude process still alive
- Send graceful exit payloads.
- Relaunch with `--resume`.

This is imperfect, but it is no worse than the current immediate proactive
exit and should reduce mid-output interruptions.

Status: implemented in wrapper mode on 2026-04-25. The quiet-boundary detector
is terminal-activity based, with a hard max-wait fallback.

Phase 2 boundary:

- Watch Claude transcript JSONL for assistant turn completion.
- Treat a completed assistant turn as the preferred proactive swap boundary.
- If tool-use records are visible, do not swap between tool start and tool
  result.
- Keep a timeout fallback so a stuck session does not block forever.

Phase 3 boundary:

- Add hook-based state if Claude Code exposes reliable pre/post tool or
  stop-turn hooks.
- Store explicit runtime fields:
  - `swap_pending`
  - `swap_reason`
  - `last_activity_at`
  - `last_assistant_turn_completed_at`
  - `tool_in_flight`
  - `safe_to_restart`

Do not require Phase 3 to ship the first working version.

## Dashboard And Connector Model

The dashboard is the long-lived owner of account, usage, and plain-`claude`
connection visibility. The command the user types is connected to ccswap by a
tiny command connector.

Dashboard responsibilities:

- keep the account list and usage snapshots fresh
- select the initial account for a new Claude launch
- expose active account and swap state
- show whether plain `claude` is connected
- write a dashboard heartbeat while it is running

Wrapper responsibilities:

- decide when a session should become `swap_pending`
- decide when a pending session is safe to restart
- relaunch the child process with the next account token

Connector responsibilities:

- be named `claude` or be earlier in PATH than the real Claude binary
- find the real Claude binary without recursing into itself
- forward args, cwd, terminal size, stdin, stdout, and stderr
- call the current `ccswap claude` wrapper for now
- later, ask a daemon to manage the session if a separate daemon/IPC layer is
  added

The connector should not contain token-routing policy. It should be a thin entry
point.

## Auth Mode Policy

Recommended mode policy:

- `keychain_copy`: stable default until connector behavior and token lifetime
  behavior are proven.
- `oauth_env`: preferred no-Keychain mode for the next production experiment.

Removed mode:

- `proxy`: tested against fake upstreams and real Anthropic OAuth traffic, then
  removed from the runnable product surface after real forwarding returned
  `401`.

Do not reintroduce `proxy` as the production answer unless a future Claude Code
or Anthropic contract explicitly makes generic OAuth forwarding work. The
setup-token forwarding check did not produce an upstream-compatible token
class.

## Implementation Plan

### 1. Setup-Token Forwarding Check

Status: done on 2026-04-25. This was the only proxy-side experiment worth doing
before committing fully to safe relaunch.

- Done: generated a `claude setup-token` token for one account.
- Done: verified direct Claude Code child-process auth:

  ```sh
  CLAUDE_CODE_OAUTH_TOKEN="$SETUP_TOKEN" claude -p "Return exactly ok"
  ```

- Done: captured Claude's `/v1/messages?beta=true` request with that token and
  re-sent it through generic Node `fetch`.
- Done: compared the result with the known failing `claudeAiOauth.accessToken`
  path.
- Done: removed local temporary token files after the test.

Decision:

- If setup-token forwarding returns `401`, close proxy mode for production.
- If setup-token forwarding succeeds, revisit proxy mode using setup-token
  enrollment instead of `/login` access tokens.

Observed result: setup-token forwarding returned `401 Invalid authentication
credentials`. Proxy mode is closed for production unless Anthropic or Claude
Code exposes a new supported forwarding contract.

Next implementation task completed: `docs/next-task-safe-relaunch.md`.

### 2. Archive Proxy Findings And Remove Proxy Code

- Remove the `ccswap proxy` CLI and real proxy-mode launch path.
- Remove proxy fake-upstream/probe tests from the active test suite.
- Keep the failure analysis doc so no worker treats proxy token swapping as the
  next production path.

Done means the project preserves the research result without keeping dead
runtime code in the product.

### 3. Make `oauth_env` The Main Experiment

- Keep `ccswap token-probe <account> --infer`.
- Ensure `auth_mode: "oauth_env"` launches normal `ccswap claude` without
  calling `activateAccountCredential()`.
- Keep token values out of logs and errors.
- Add or keep tests around `buildClaudeLaunchAuth()`.
- Document that access-token refresh behavior is not fully proven.

Done means users can run without global Keychain mutation.

### 4. Add Pending Swap Runtime State

Status: done for Phase 1 wrapper mode.

Extend runtime state with fields like:

```ts
swap_pending: boolean;
swap_reason: "proactive_usage" | "hard_limit" | null;
swap_requested_at: string | null;
last_activity_at: string | null;
safe_to_restart: boolean;
```

For the first version, `safe_to_restart` is written when the runner reaches the
quiet boundary. `last_activity_at` is persisted at pending/boundary moments;
per-chunk terminal activity remains an in-memory runner signal.

Done means ccswap can distinguish "usage is high" from "kill and restart now".

### 5. Replace Immediate Proactive Exit With Delayed Relaunch

Status: done for Phase 1 wrapper mode.

Previous behavior requested a proactive swap and exited Claude immediately.
Phase 1 changed that to:

1. `shouldProactivelySwap()` returns true.
2. Mark pending.
3. Continue forwarding the current Claude output.
4. When the quiet-boundary detector says safe, gracefully exit Claude.
5. Relaunch with the next account and `--resume`.
6. Rebuild args with replay mode forced to `continue`, which sends a short
   continuation prompt instead of the previous user prompt.

Done means proactive swaps happen between turns more often than mid-response.

### 6. Add Transcript-Aware Boundary Detection

Use the existing session watcher as the likely home for this work.

- Track the active transcript file.
- Parse appended JSONL records.
- Detect assistant turn completion.
- Detect tool-use start/result if those records are present.
- Expose a small runtime signal the runner can read.

Done means ccswap can avoid restarting during visible tool activity.

### 7. Add Plain Claude Connection

Status: done for wrapper mode.

- Dashboard writes a heartbeat while it is running.
- Dashboard auto-connects the plain `claude` command when there is no PATH or
  backup conflict; `ccswap connect` remains the manual repair command.
- Connection resolves the real Claude binary once and stores it in ccswap
  config.
- Connection prevents recursion by checking the resolved real Claude path.
- Connection forwards all args to `ccswap claude`.

Done means the app can stay open, show whether plain `claude` is connected, and
let the user type plain `claude`.

### 8. Optional Daemon Session Manager

Only start this if the wrapper path needs stronger central ownership.

- Dashboard starts the daemon or embeds its manager.
- Daemon keeps session records under the ccswap runtime directory.
- Daemon can spawn and restart Claude children.
- Dashboard displays account, usage, pending swap, and last restart reason.

## Test Plan

Automated tests:

- `buildClaudeLaunchAuth()` does not mutate Keychain in `oauth_env` mode.
- `buildClaudeEnv()` removes ambient Anthropic auth unless intentionally set.
- proactive threshold marks pending before requesting process exit.
- proactive relaunch rebuilds args with `--resume` and a continuation prompt,
  without last-prompt replay.
- hard-limit relaunch keeps the existing replay behavior.
- safe-boundary detector waits through recent output.
- connector resolver refuses to recurse into itself.
- proxy production/CLI code is removed while its failure evidence remains
  documented.
- setup-token forwarding check failed with `401`, so proxy production work is
  closed.

Manual tests:

- `ccswap token-probe <account> --infer`
- `auth_mode: "oauth_env"` with `ccswap claude -p "Return exactly ok"`
- setup-token direct child-process probe: done, returned `ok`
- setup-token generic forwarding probe: done, returned `401`
- proactive threshold set low, for example 1%, to force a pending swap
- verify the next launch uses the next account
- verify resumed session id is the same
- verify the last prompt is not replayed on proactive swap
- verify the continuation prompt is sent after proactive relaunch
- verify no OAuth token appears in terminal output or logs

## Open Risks

- Stored `/login` access tokens may expire during long sessions.
- The exact refresh-token environment contract is not proven.
- Quiet-window detection is heuristic until transcript or hook signals are
  reliable.
- Relaunch is still visible if it happens while the user is watching the
  terminal.
- Multiple simultaneous Claude sessions need account locking or per-session
  routing decisions, optionally through a daemon.

These risks are smaller than the proxy risk because they stay on the verified
Claude Code process-auth path.

## Completion Definition

The next solution is complete when:

- `auth_mode: "oauth_env"` can run normal Claude sessions with no Keychain copy.
- proactive swaps wait for a safe boundary instead of exiting immediately.
- proactive swaps relaunch with `--resume <session-id>` and a continuation
  prompt, without last-prompt replay.
- hard-limit swaps still recover with replay when needed.
- the dashboard can show active account and pending swap state.
- the user can type plain `claude` through a connector managed by the
  dashboard.
- proxy mode is removed from runnable code and documented as unsupported for
  real OAuth token swapping.
- setup-token forwarding has been tested and does not reopen proxy mode.
