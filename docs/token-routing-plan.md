# Token Routing Plan

This note is for the next agent working on ccswap.

## Current State

ccswap no longer creates or writes per-account Claude config directories. All accounts share the normal Claude Code config and transcript area, especially `~/.claude` and `~/.claude/projects`.

Account identity is currently represented by stored credentials:

- ccswap stores each account credential in its own OS credential-store entry.
- The current fallback path activates an account by copying that credential into Claude Code's standard credential slot.
- Claude is still launched through ccswap so ccswap can watch usage, session state, limit text, and relaunch with `--resume`.

The recently removed legacy path was:

- `claude_config_dir`
- `~/.config/ccswap/accounts/<name>/claude`
- account-specific `CLAUDE_CONFIG_DIR`

Legacy config files may still contain `claude_config_dir`; the TypeScript loader should keep accepting it but should not save it back.

## Goal

Move away from global Keychain credential mutation where possible.

Preferred direction:

1. Try per-process OAuth token injection.
2. If that is not sufficient, prototype a local API/auth proxy.
3. Keep Keychain-copy activation as fallback.

The user-facing goal is:

- The dashboard/daemon can stay running.
- The user can type `claude` normally through a shim.
- ccswap manages account selection and usage behind the scenes.
- No per-account Claude environment folders.

## Option 1: Per-Process OAuth Token Injection

Claude Code 2.1.120 appears to support per-process auth through environment variables.

Evidence from local investigation:

- `CLAUDE_CODE_OAUTH_TOKEN=... claude auth status --json` selects `authMethod: "oauth_token"` even with a fake token.
- `ANTHROPIC_AUTH_TOKEN=... claude auth status --json` also selects token-style auth.
- `ANTHROPIC_API_KEY=... claude auth status --json` selects API-key auth.
- `claude setup-token` exists and creates a long-lived subscription OAuth token for `CLAUDE_CODE_OAUTH_TOKEN`.
- Official Claude Code docs list auth precedence with `CLAUDE_CODE_OAUTH_TOKEN` before normal subscription OAuth credentials.

Current ccswap blocks this path:

- `src/core/env.ts` deletes `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_AUTH_TOKEN`.
- `src/claude/session.ts` launches Claude using `buildClaudeEnv()`.
- `src/core/credentials.ts` still contains the Keychain-copy activation path.

Recommended first experiment:

1. Read one ccswap account credential from the OS credential store.
2. Parse `claudeAiOauth.accessToken` in memory only.
3. Spawn:

   ```sh
   CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude auth status --json
   ```

4. Spawn a tiny inference in a scratch trusted directory:

   ```sh
   CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" claude -p "Return exactly ok"
   ```

5. If that works, add an experimental launch path where ccswap injects `CLAUDE_CODE_OAUTH_TOKEN` for the child process instead of mutating the standard Claude Code credential.

Initial implementation:

- `ccswap token-probe <account>` reads the saved ccswap account credential, parses `claudeAiOauth.accessToken`, and runs `claude auth status --json` with `CLAUDE_CODE_OAUTH_TOKEN` set only for that child process.
- `ccswap token-probe <account> --infer` additionally runs `claude -p "Return exactly ok"` from a scratch cwd after auth status succeeds.
- `auth_mode` now supports `keychain_copy` and experimental `oauth_env`. Default remains `keychain_copy`.
- In `oauth_env` mode, normal `ccswap run` / `ccswap claude` launches inject the selected account's `CLAUDE_CODE_OAUTH_TOKEN` instead of mutating Claude Code's standard credential.

Open risk:

- The access token stored by `/login` may be short-lived. It is not yet proven that injecting only `claudeAiOauth.accessToken` can refresh. Binary strings mention `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_OAUTH_SCOPES`, so refresh-token injection may exist, but it needs a careful no-leak test.
- The official `claude setup-token` flow creates a one-year token and may be more reliable, but it changes account enrollment UX.
- Env tokens are easier to leak to child processes or debug output than Keychain entries. Avoid logging token values.

## Option 2: Local API/Auth Proxy

Proxy mode also appears feasible for core inference traffic.

Local probe result:

- With `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` and `ANTHROPIC_AUTH_TOKEN=probe-token`, Claude Code sent:
  - `HEAD /`
  - `POST /v1/messages?beta=true`
  - `Authorization: Bearer probe-token`
  - `X-Claude-Code-Session-Id: <uuid>`
  - `anthropic-beta: ...`
- `ANTHROPIC_BASE_URL` is the important variable. Quick probes found generic names like `API_BASE_URL` are not the right surface.

What the proxy must handle:

- `HEAD /`
- `POST /v1/messages?beta=true`
- probably `/v1/messages/count_tokens`
- streaming SSE pass-through
- non-streaming fallback
- upstream auth replacement
- preservation of headers such as:
  - `anthropic-version`
  - `anthropic-beta`
  - `x-claude-code-session-id`
  - `x-app`
  - request-id and retry-related headers where applicable

Suggested proxy experiment:

1. Add a standalone experimental command, for example:

   ```sh
   ccswap proxy --probe
   ```

2. The probe should:
   - start a local HTTP server on `127.0.0.1` with an ephemeral port
   - launch `claude -p "Return exactly ok"` with `ANTHROPIC_BASE_URL` pointed to the server
   - confirm Claude sends `HEAD /` and `POST /v1/messages?beta=true`
   - redact auth headers in logs
   - optionally pass through to `https://api.anthropic.com`

3. Once request capture is stable, add upstream pass-through.
4. Once pass-through is stable, replace upstream `Authorization` from the selected ccswap account credential.

Initial implementation:

- `ccswap proxy --probe` starts a capture-only HTTP server bound to `127.0.0.1` on an ephemeral port.
- The probe launches `claude -p "Return exactly ok"` with `ANTHROPIC_BASE_URL` pointed at the capture server and `ANTHROPIC_AUTH_TOKEN=probe-token`.
- It reports whether `HEAD /` and `POST /v1/messages?beta=true` were observed, redacts auth-like values, records whether `x-claude-code-session-id` was present, and records the request body's `stream` flag when JSON is available.
- It does not implement upstream pass-through or account routing yet.

Proxy-only work breakdown:

1. CLI surface
   - Add `ccswap proxy --probe`.
   - Add `--upstream` only after capture-only mode works.
   - Add `--account <name>` only after upstream pass-through works.
   - Add `--json` only if another tool needs machine-readable probe output.
   - Keep proxy commands experimental and separate from normal `ccswap claude`.

2. Capture server
   - Bind to `127.0.0.1`, never `0.0.0.0`.
   - Use an ephemeral port by default.
   - Respond `200` to `HEAD /`.
   - Capture `POST /v1/messages?beta=true`.
   - Capture unknown routes without crashing; report them as unsupported.
   - Stop the server when the child Claude process exits or the probe times out.
   - Add a hard timeout so `ccswap proxy --probe` cannot hang forever.

3. Probe child launch
   - Resolve the real Claude binary through existing config.
   - Spawn `claude -p "Return exactly ok"` for the probe.
   - Set `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` only for the child process.
   - Set a fake `ANTHROPIC_AUTH_TOKEN=probe-token` only for capture mode.
   - Use a scratch trusted cwd for probe execution.
   - Preserve the parent environment except for auth/base-url overrides that are intentional.

4. Request inspection
   - Record method and path.
   - Record whether `authorization` was present, but never its value.
   - Record whether `x-api-key` was present, but never its value.
   - Record whether `x-claude-code-session-id` was present.
   - Record `anthropic-version`.
   - Record presence of `anthropic-beta` and whether it includes OAuth-related beta values; do not require an exact full string unless a test fixture controls it.
   - Parse JSON bodies when possible.
   - Record whether the request body has `stream: true`.
   - Record model name and max token fields only if useful and non-sensitive.

5. Redaction and logging
   - Redact `authorization`, `x-api-key`, cookies, and any token-like values.
   - Do not print full request bodies by default.
   - If a debug flag is added, keep auth redaction mandatory.
   - Ensure thrown errors and test snapshots cannot include raw token values.

6. Capture-mode success criteria
   - `HEAD /` observed.
   - `POST /v1/messages?beta=true` observed.
   - Claude child actually used `ANTHROPIC_BASE_URL`.
   - Auth-like header was present in the request.
   - Session header was present or explicitly reported missing.
   - Probe exits with a clear non-zero status if no POST is observed.

7. Upstream pass-through
   - Implement only after capture-mode tests pass.
   - Forward to `https://api.anthropic.com`.
   - Preserve path and query string exactly.
   - Preserve required Anthropic headers:
     - `anthropic-version`
     - `anthropic-beta`
     - `x-claude-code-session-id`
     - `x-app`
   - Preserve method and body.
   - Strip hop-by-hop headers.
   - Do not forward the capture-mode fake token to upstream.
   - Add a fake upstream test server before trying real Anthropic traffic.

8. SSE streaming
   - Support streaming response pass-through without buffering the full response.
   - Preserve `content-type: text/event-stream` when upstream returns it.
   - Pipe chunks through with backpressure.
   - Handle upstream aborts and child disconnects cleanly.
   - Test a fake SSE stream with multiple events.
   - Confirm Claude Code does not fall back to non-streaming because of proxy formatting.

9. Non-streaming fallback
   - Support ordinary JSON responses as well as SSE.
   - Forward upstream status codes.
   - Forward Anthropic-compatible error bodies.
   - Preserve enough headers for Claude Code retry/error handling.

10. Account auth replacement
    - Start only after pass-through works with a fake upstream.
    - Load selected ccswap account credential in memory.
    - Parse `claudeAiOauth.accessToken` without logging it.
    - Replace upstream `Authorization` with `Bearer <selected access token>`.
    - Remove incoming `x-api-key` if the upstream request should use OAuth bearer auth.
    - Keep using the stored account's usage cache attribution.
    - Do not call `activateAccountCredential()` in proxy account-routing mode.

11. Session routing
    - Use `x-claude-code-session-id` as the primary session key.
    - Maintain a map from Claude session id to ccswap account name.
    - Decide what to do when the session header is absent:
      - fail closed for account-routing mode, or
      - route to the active account with a warning in probe-only mode.
    - Persist routing in runtime or daemon state only if normal runs start using the proxy.

12. Usage and swap integration
    - Keep `/api/oauth/usage` polling independent of proxy message routing at first.
    - Confirm usage cache updates for the selected ccswap account.
    - Use the existing proactive threshold to decide when a session should move to another account.
    - In proxy mode, prefer switching the session-to-account map before the next request instead of killing Claude.
    - If a request is already streaming, wait until it finishes before changing the route for that session.

13. Security constraints
    - Localhost only.
    - No token values in logs.
    - No request-body logging by default.
    - No persistent proxy auth cache unless encrypted or already stored in OS credential store.
    - Treat proxy mode as experimental until it survives streaming and account-routing tests.

14. Tests
    - Unit test route handling for `HEAD /`.
    - Unit test capture of `POST /v1/messages?beta=true`.
    - Unit test auth redaction.
    - Unit test timeout behavior.
    - Integration test pass-through with a fake upstream JSON response.
    - Integration test pass-through with a fake upstream SSE response.
    - Integration test account auth replacement without exposing token values.
    - Keep real Anthropic calls out of automated tests.

15. Manual verification
    - Run capture-only `ccswap proxy --probe`.
    - Run pass-through against a fake upstream.
    - Run one real `claude -p "Return exactly ok"` through proxy only after fake upstream tests pass.
    - Verify streaming output works.
    - Verify no tokens appear in terminal output.
    - Verify disabling proxy mode returns normal ccswap behavior.

Proxy risks:

- This is a larger unsupported surface than env token injection.
- SSE correctness matters.
- Claude Code betas and headers must be preserved or features may break.
- OAuth usage and subscription behavior may depend on headers such as `oauth-2025-04-20`.
- The proxy will hold or inject real tokens, so logging and localhost binding must be conservative.

## Option 3: Keychain Copy Fallback

Keep the current Keychain-copy activation path until token injection or proxy mode is proven.

This fallback is less elegant but stable because it follows Claude Code's normal subscription credential path. It still requires a ccswap wrapper/daemon to choose accounts, watch usage, and relaunch Claude.

## Suggested Implementation Order

1. Add a small internal token-injection experiment command.
2. Add tests around env construction so token injection can be enabled explicitly without leaking into the default path.
3. If one-shot `CLAUDE_CODE_OAUTH_TOKEN` inference works, add an experimental account launch mode:

   ```json
   {
     "auth_mode": "oauth_env"
   }
   ```

4. Keep default mode as Keychain copy until refresh behavior is proven.
5. Add `ccswap proxy --probe` after env injection is evaluated.
6. Only wire proxy into daemon/session management after the probe succeeds with streaming.

## Work Checklist

Use this as the handoff checklist. Items are intentionally small enough for a worker agent to take one slice at a time.

### A. Completed Cleanup Baseline

- Confirm `claude_config_dir` is not part of `AccountData`.
- Confirm `addAccount()` no longer creates `~/.config/ccswap/accounts/<name>/claude`.
- Confirm `ccswap init` no longer creates `~/.config/ccswap/accounts`.
- Confirm legacy configs with `claude_config_dir` still load.
- Confirm legacy `claude_config_dir` is dropped on save.
- Confirm README says per-account Claude config folders are gone.

### B. Token Injection Probe

- Add a small command such as `ccswap token-probe <account>`.
- Reuse existing account lookup and credential parsing.
- Never print token values.
- Inject `CLAUDE_CODE_OAUTH_TOKEN` only into the spawned child process.
- Run `claude auth status --json` and report only non-secret fields:
  - `loggedIn`
  - `authMethod`
  - `apiProvider`
  - account/email if Claude returns it
- Add `--infer` to run one tiny `claude -p "Return exactly ok"` inference.
- Use a scratch trusted cwd for the inference probe.
- Add tests for argument parsing and redacted output.
- Keep normal `ccswap claude` behavior unchanged until the probe proves inference works.

### C. Token Injection Launch Mode

- Add an explicit config field only after the probe works, for example:

  ```json
  {
    "auth_mode": "keychain_copy"
  }
  ```

- Supported values should start minimal:
  - `keychain_copy`
  - `oauth_env`
- Default must remain `keychain_copy`.
- Update `buildClaudeEnv()` so token injection is opt-in and test-covered.
- In `oauth_env` mode, avoid `activateAccountCredential()` for normal launches.
- Pass `CLAUDE_CODE_OAUTH_TOKEN` from the selected account credential into the Claude child env.
- Keep deleting ambient `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and Anthropic base-url env unless a future mode intentionally uses them.
- Validate that usage capture still attributes snapshots to the selected ccswap account.
- Validate account switching still rebuilds `--resume <session-id>` correctly.

### D. Token Refresh Investigation

- Inspect the stored credential shape without logging secrets.
- Check whether stored credentials include refresh token and scopes fields.
- Probe whether `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` plus `CLAUDE_CODE_OAUTH_SCOPES` is accepted.
- Decide whether `/login` credentials are usable for long sessions.
- If not, document that `oauth_env` requires `claude setup-token` enrollment.
- Do not implement refresh-token injection until a no-leak probe proves the exact env contract.

Current finding:

- The stored `/login` credential shape includes `claudeAiOauth.accessToken`, `expiresAt`, `refreshToken`, `scopes`, `rateLimitTier`, and `subscriptionType`.
- A no-secret probe with fake `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_OAUTH_SCOPES` did not select a refresh-token auth method; `claude auth status --json` fell back to normal `claude.ai` auth.
- `oauth_env` therefore remains access-token-only and experimental. Long-session refresh behavior is not proven; keep `keychain_copy` as default until the exact refresh env contract is verified or enrollment moves to `claude setup-token`.

### E. Proxy Probe

- Add a separate command such as `ccswap proxy --probe`.
- Bind only to `127.0.0.1` on an ephemeral port.
- Redact all auth-like headers and token-looking strings in logs.
- Start with capture-only behavior:
  - respond `200` to `HEAD /`
  - capture `POST /v1/messages?beta=true`
  - report whether `x-claude-code-session-id` is present
  - report whether request body has `stream: true`
- Then add optional pass-through behind a flag, for example `--upstream`.
- Pass through to `https://api.anthropic.com`.
- Preserve Anthropic headers and query strings.
- Support SSE streaming without buffering the whole response.
- Support non-streaming JSON fallback.
- Add tests with a fake upstream server.

### F. Proxy Account Routing

- Only start after proxy pass-through works.
- Load the selected ccswap account credential in memory.
- Replace upstream `Authorization` with the selected account access token.
- Do not mutate Claude Code's standard Keychain credential.
- Track routing by `x-claude-code-session-id` when possible.
- Add a session-to-account map in runtime state or daemon state.
- Do not log raw headers after auth replacement.
- Confirm `/api/oauth/usage` polling still uses the intended account token.

### G. Daemon And Shim Direction

- Keep this separate from token/proxy probes.
- Target UX:
  - dashboard/daemon is always running
  - user types `claude`
  - PATH shim forwards to ccswap
  - ccswap launches or attaches a managed Claude PTY
- The shim must find the real Claude binary without recursing into itself.
- The daemon should centralize:
  - active sessions
  - selected account per session
  - usage snapshots
  - token/proxy mode
  - relaunch/resume decisions
- Multiple simultaneous sessions need account locking or routing rules.
- The current wrapper path should remain available during daemon development.

### H. Safe Swap Timing

- Avoid killing Claude while a tool is actively running.
- Introduce runtime fields only if needed:
  - `swap_pending`
  - `tool_in_flight`
  - `last_tool_finished_at`
- Prefer Claude Code hook events or transcript JSONL evidence for tool boundaries.
- Swap at a quiet boundary:
  - after tool result
  - before the next LLM request
  - or after a turn stops
- For proactive threshold swaps, resume without replaying the last prompt.
- For hard limit swaps, keep the existing replay behavior unless token/proxy mode makes it unnecessary.

### I. Verification Required Before Shipping

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- Manual `claude auth status --json` probe with fake token should not be treated as proof of usable inference.
- Manual real-token inference must be performed before enabling `oauth_env`.
- Proxy pass-through must be tested with streaming output before it is wired into normal runs.
- Confirm no token values appear in stdout, stderr, test snapshots, debug logs, or thrown errors.

### J. Files Most Likely To Change

- `src/core/env.ts`
- `src/core/credentials.ts`
- `src/core/config.ts`
- `src/claude/session.ts`
- `src/claude/runner.ts`
- `src/cli.ts`
- `src/commands/*`
- `tests/core.test.ts`
- `tests/runner.integration.test.ts`
- new proxy tests if proxy work starts
- README after a mode becomes user-facing

## Do Not Reintroduce

- Per-account `CLAUDE_CONFIG_DIR`
- Account-specific Claude project/log/cache directories
- `~/.config/ccswap/accounts/<name>/claude` creation
- New code that depends on `claude_config_dir`

If legacy config handling is touched, keep it one-way: read old fields, drop them on save.
