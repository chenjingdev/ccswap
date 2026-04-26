# Implemented: Safe OAuth Env Relaunch

Status on 2026-04-25: Phase 1 is implemented for wrapper mode. The
implementation removes the failed proxy product path and changes proactive
swaps from immediate-exit behavior to pending-first quiet-boundary relaunch.

Implemented pieces:

- `SessionRuntimeState` now includes `swap_pending`, `swap_reason`,
  `swap_requested_at`, `last_activity_at`, and `safe_to_restart`, with
  backward-compatible defaults for older runtime files.
- `runClaude()` marks proactive swaps pending, tracks terminal output/stdin
  activity in memory, waits for `proactiveQuietMs`, and forces a relaunch after
  `proactiveMaxWaitMs`.
- `runClaudeSession()` writes pending/boundary runtime state, clears pending
  fields before the next launch, and keeps proactive relaunches on
  `--resume <session-id>` with a short continuation prompt instead of replaying
  the previous user prompt.
- Tests cover quiet-window delay, max-wait forcing, pending callback count,
  hard-limit behavior, runtime backcompat, pending/clear state, and proactive
  continuation-without-last-prompt args.

Remaining later work:

- full daemon/session manager
- transcript JSONL or hook-based tool/turn boundary detection
- full session-level integration coverage that observes pending, boundary, and
  clear state across a real relaunch loop

This was the Phase 1 implementation task after both proxy OAuth forwarding
checks failed against the real Anthropic upstream.

Do not continue proxy-token-swap work for production. The failed paths are:

- `claude auth login` credential `claudeAiOauth.accessToken`
- `claude setup-token` long-lived token

Both work when passed directly to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`.
Both fail when re-sent by generic fetch/curl/proxy forwarding to the real
Anthropic upstream with `401 Invalid authentication credentials`.

## Goal

Make proactive swaps less disruptive by delaying the relaunch until a quiet
boundary.

Current behavior:

```text
usage threshold reached -> immediately request Claude exit -> relaunch --resume
```

Target behavior:

```text
usage threshold reached -> mark swap pending -> wait for quiet boundary ->
gracefully exit Claude -> relaunch --resume with a continuation prompt
```

This remains a relaunch-based solution, but it should avoid interrupting
active output or tool work as often as the current immediate proactive exit.

## Scope

Phase 1 is implemented. Dashboard-owned plain `claude` connection is also
implemented. Do not treat this as transcript/hook-aware boundary work.

Phase 1 means:

- wrapper/connector mode: `ccswap claude ...`, or plain `claude` after
  connecting it from the dashboard or running `ccswap connect`
- `auth_mode: "oauth_env"` and `keychain_copy` both supported
- proxy production mode and CLI are removed after the real-upstream failure
- quiet-boundary detection can be terminal-activity based
- no transcript JSONL parser yet
- no hook-based tool boundary detector yet

## Files Changed

Primary files:

- `src/claude/runner.ts`
- `src/claude/session.ts`
- `src/core/runtime.ts`
- `tests/runner.integration.test.ts`
- `tests/core.test.ts` or a new focused runtime test file if needed

Documentation:

- `docs/oauth-env-relaunch-solution.md`
- `docs/token-routing-plan.md`
- `README.md` only if user-facing behavior changes

Proxy internals are no longer part of the active runnable code path.

## Runtime State

Extend `SessionRuntimeState` with optional-safe fields:

```ts
swap_pending: boolean;
swap_reason: "proactive_usage" | "hard_limit" | null;
swap_requested_at: string | null;
last_activity_at: string | null;
safe_to_restart: boolean;
```

Backward compatibility matters. `loadRuntimeState()` must keep loading old
runtime files where these fields are absent.

Suggested defaults:

```ts
swap_pending: false;
swap_reason: null;
swap_requested_at: null;
last_activity_at: null;
safe_to_restart: false;
```

## Runner Changes

Before this change, `src/claude/runner.ts` called `tryGracefulExit()` immediately when
`shouldProactivelySwap()` returns true and `onProactiveSwap()` does not handle
the swap.

The implemented path gives proactive swap two stages:

1. Detect threshold and mark pending.
2. Exit only after the quiet-boundary detector says it is safe.

Add runner options along these lines:

```ts
onProactiveSwapPending?: () => void;
onProactiveSwapBoundary?: () => void;
proactiveQuietMs?: number;
proactiveMaxWaitMs?: number;
```

Recommended defaults:

- `proactiveQuietMs`: 1500 ms
- `proactiveMaxWaitMs`: 30000 ms

Track terminal activity:

- update `lastActivityAt` on every child output chunk
- update `lastActivityAt` on every stdin chunk from the user
- when pending, consider it quiet if `Date.now() - lastActivityAt >= proactiveQuietMs`
- force the relaunch after `proactiveMaxWaitMs` even if quiet never happens

When the pending swap finally exits Claude:

- set `proactiveSwapRequested = true`
- call `onProactiveSwapBoundary()`
- print one clear message, for example:

  ```text
  [ccswap] Usage threshold reached. Restarting Claude at a quiet boundary...
  ```

- call the existing graceful exit and escalation timers

Keep hard-limit behavior unchanged. A hard limit should still exit quickly
after confirmation.

## Session Changes

In `src/claude/session.ts`:

- when proactive threshold is detected, update runtime state:

  ```ts
  swap_pending: true
  swap_reason: "proactive_usage"
  swap_requested_at: new Date().toISOString()
  safe_to_restart: false
  ```

- when the runner reaches the quiet boundary, update:

  ```ts
  safe_to_restart: true
  ```

- after relaunch starts with the next account, clear:

  ```ts
  swap_pending: false
  swap_reason: null
  swap_requested_at: null
  safe_to_restart: false
  ```

The existing proactive resume behavior must remain:

```ts
buildResumeArgs(
  opts.originalArgs,
  { ...latest, replay_mode: "continue", last_prompt: null, custom_prompt: null },
  false,
)
```

That is the important behavior: force `continue` so ccswap sends a small
continuation prompt without replaying the previous user prompt.

## Proxy Mode

Do not use proxy mode to solve this task.

The proxy implementation/CLI has been removed after the real-upstream
forwarding failure. Keep `docs/proxy-oauth-forwarding-failure.md` as the
historical evidence, but do not keep production branches for `auth_mode:
"proxy"`.

## Tests

Add or update tests for these cases:

1. Proactive swap does not exit immediately while the child is still producing
   output.
2. Proactive swap exits after the quiet window.
3. Proactive swap exits after `proactiveMaxWaitMs` even if output never goes
   quiet.
4. `onProactiveSwapPending` is called once per proactive swap.
5. Hard-limit behavior remains fast and unchanged.
6. Runtime state loads old files without the new fields.
7. Runtime state records pending and clears it after relaunch setup.
8. Proactive relaunch still uses `--resume <session-id>` and sends only the
   continuation prompt, not the previous user prompt.

Use fake Node child scripts in `tests/runner.integration.test.ts`, following
the existing test style.

## Manual Verification

After tests pass:

```sh
pnpm typecheck
pnpm test
```

Then run a low-threshold manual check with a disposable config:

```json
{
  "auth_mode": "oauth_env",
  "proactive_swap_threshold_pct": 1
}
```

Expected behavior:

- ccswap reports that usage threshold was reached
- Claude is not killed in the middle of active output
- ccswap relaunches with the next account
- relaunch uses the same session id
- proactive relaunch does not append the previous prompt

## Completion Definition

This task is complete when:

- setup-token failure remains documented as closing proxy production work
- proactive swaps are pending-first, not immediate-exit-first
- wrapper mode relaunches at a quiet boundary
- proactive relaunch keeps `--resume` and sends a continuation prompt without
  replaying the previous user prompt
- hard-limit recovery still works
- `pnpm typecheck` and `pnpm test` pass
