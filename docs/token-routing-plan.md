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

## Do Not Reintroduce

- Per-account `CLAUDE_CONFIG_DIR`
- Account-specific Claude project/log/cache directories
- `~/.config/ccswap/accounts/<name>/claude` creation
- New code that depends on `claude_config_dir`

If legacy config handling is touched, keep it one-way: read old fields, drop them on save.
