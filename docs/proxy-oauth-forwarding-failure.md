# Proxy OAuth Forwarding Failure

This document records why the planned "swap only the token through a local
proxy" design does not currently work against the real Anthropic upstream.

## Summary

The local proxy architecture works mechanically:

- Claude Code can be pointed at a localhost proxy with `ANTHROPIC_BASE_URL`.
- The proxy can observe `HEAD /` and `POST /v1/messages?beta=true`.
- The proxy can preserve method, path, query, body, and Anthropic headers.
- The proxy can stream fake upstream SSE responses without buffering.
- The proxy can replace `Authorization` with a selected ccswap account token.
- The proxy can route by `x-claude-code-session-id` against fake upstreams.

However, real Anthropic OAuth traffic does not work when re-sent by a generic
HTTP proxy. The same selected account token succeeds when used by Claude Code
through `CLAUDE_CODE_OAUTH_TOKEN`, but requests re-sent by Node `fetch`, curl,
or the ccswap proxy are rejected by the real upstream with:

```text
401 Invalid authentication credentials
```

Because of this, `auth_mode: "proxy"` is not a supported real-upstream mode.
The implementation and CLI were removed from ccswap after the failure was
confirmed; this document remains as the archived research record.

## Intended Design

The intended no-relaunch swap design was:

1. Start a local proxy bound to `127.0.0.1`.
2. Launch Claude Code once with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`.
3. For each `/v1/messages` request, route by `x-claude-code-session-id`.
4. Replace upstream `Authorization` with the OAuth access token for the routed
   ccswap account.
5. When usage crosses the proactive threshold, update the route before the
   next model request.
6. Keep the Claude process alive; do not replay the prompt and do not relaunch
   with `--resume`.

That design assumes that the visible HTTP request from Claude Code can be
replayed by a proxy as long as the bearer token and headers are correct. That
assumption is false for the current Claude Code OAuth path.

## What Works

### Direct Claude Code OAuth Env

This works:

```sh
ccswap token-probe chenjingdev@gmail.com --infer
```

Observed result:

```json
{
  "loggedIn": true,
  "authMethod": "oauth_token",
  "apiProvider": "firstParty"
}
```

The tiny inference also returned exactly:

```text
ok
```

Normal ccswap launch with the current `oauth_env` config also works:

```sh
ccswap claude -p 'Return exactly ok'
```

Observed result:

```text
ok
```

### Local Capture Probe

This worked during the now-removed proxy experiment:

```sh
ccswap proxy --probe
```

Observed request shape:

```text
HEAD /
POST /v1/messages?beta=true
authorization: Bearer [redacted]
x-claude-code-session-id: present
anthropic-version: 2023-06-01
anthropic-beta: present
stream: true
```

This proves Claude Code can be pointed at a local proxy and that the proxy can
see the relevant model request boundary.

### Fake Upstream Proxying

Automated tests pass for fake upstream behavior:

- JSON pass-through.
- `/v1/messages/count_tokens` pass-through.
- SSE chunk pass-through.
- Auth replacement.
- Token redaction.
- Session route update for the next request.
- Retry with another account on fake upstream `429`.
- Fail-closed behavior when a routed model request has no session id.

These tests prove the proxy implementation is mechanically correct as an HTTP
proxy. They do not prove real Claude OAuth upstream compatibility.

## What Fails

### Real Upstream Through ccswap Proxy

This failed during the now-removed proxy experiment:

```sh
ccswap proxy --probe --upstream --account chenjingdev@gmail.com
```

Observed result:

```text
Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}
```

The command exits with status `1`.

Important detail: the proxy did still observe the expected request pair:

```text
HEAD /
POST /v1/messages?beta=true
```

So this is not a routing, binding, path, query, or timeout failure. It is an
upstream authentication failure after the request is forwarded.

### Manual Replay With the Same Token

A direct Claude Code run using `CLAUDE_CODE_OAUTH_TOKEN` succeeds, but manually
posting to the Anthropic messages endpoint with that same bearer token fails:

```text
401 Invalid authentication credentials
```

The same failure was reproduced with both Node `fetch` and curl.

This means the stored Claude OAuth access token is not accepted as a generic
Anthropic API bearer token through ordinary HTTP clients, even when Claude Code
itself can use it successfully through its own OAuth client path.

### Token-Only Swap Replay

The critical swap experiment was:

1. Launch Claude Code with account A's `CLAUDE_CODE_OAUTH_TOKEN`.
2. Capture the visible `/v1/messages?beta=true` request.
3. Re-send the captured request to the real Anthropic upstream.
4. Replace only `Authorization` with account B's OAuth access token.

Result:

```text
401 Invalid authentication credentials
```

That directly disproves the desired "just swap the bearer token" behavior.

### Billing Marker Replacement Did Not Fix It

The captured request body contains Claude Code billing metadata in a system
message, for example:

```text
x-anthropic-billing-header: cc_version=...; cc_entrypoint=sdk-cli; cch=...
```

Because that marker differs per account/token, another experiment was run:

1. Capture account A's request.
2. Capture account B's request.
3. Replace account A's `cch` marker with account B's marker.
4. Replace metadata fields that differed between account A and account B.
5. Send the modified account A request using account B's bearer token.

Result:

```text
401 Invalid authentication credentials
```

So the visible `Authorization` header plus visible billing marker are still not
enough to make a generic proxy replay acceptable to the real upstream.

## Likely Meaning

The real Claude Code OAuth path appears to involve more than a reusable generic
bearer token on the public messages endpoint. Possibilities include:

- Claude Code uses internal client behavior that ordinary Node `fetch`/curl
  requests do not reproduce.
- OAuth subscription traffic may require an upstream-side client context not
  represented only by the visible `Authorization` header.
- Some request metadata is derived from token/client state in a way that is not
  safely reproducible by ccswap.
- The accepted path may be intentionally limited to Claude Code's own client
  runtime.

The exact upstream rule is not known. The important observed boundary is clear:
direct Claude Code with `CLAUDE_CODE_OAUTH_TOKEN` works, but generic HTTP
replay with the same visible token/request does not.

## Current Product Decision

Do not expose proxy token swapping as a supported mode.

Current safe modes:

- `keychain_copy`: stable default. Copies the selected ccswap credential into
  Claude Code's standard credential slot before launch.
- `oauth_env`: experimental but verified. Injects `CLAUDE_CODE_OAUTH_TOKEN`
  into the Claude child process without mutating the standard Keychain slot.

Removed mode:

- `proxy`: implemented enough for local/fake-upstream experiments, but blocked
  for real Anthropic OAuth upstream. The CLI, auth mode, and normal session
  proxy branches were removed after the failure was confirmed.

The real account swap behavior therefore remains relaunch/resume based:

1. Detect proactive threshold or hard limit.
2. Pick the next eligible account.
3. Relaunch Claude with the selected account auth.
4. Resume the same session with `--resume <session-id>`.

## Do Not Re-try Blindly

Future work should not spend time re-implementing the same generic proxy
forwarding loop unless one of these changes:

- Claude Code documents a supported proxy/auth forwarding contract.
- Anthropic exposes a supported OAuth bearer forwarding surface.
- A new `CLAUDE_CODE_*` environment variable or local transport proves that the
  proxy can obtain upstream-compatible per-account request metadata.
- The project moves to a different design that controls Claude Code process
  launch per request instead of replaying subscription OAuth traffic.

Until then, keep this document as the diagnostic record rather than carrying
proxy runtime code in the product.

## New Proposal: Setup-Token Forwarding Check

This is a new proposal, not "step 2" of the failed login-token proxy path.
Before permanently discarding the proxy path, test whether `claude setup-token`
produces a different kind of token that can be used by a generic HTTP
forwarder.

Status: tested on 2026-04-25. The setup-token path also fails generic
forwarding.

The failed experiments above used the access token saved by `claude auth login`
inside the stored `claudeAiOauth.accessToken` credential. That token works when
Claude Code itself receives it through `CLAUDE_CODE_OAUTH_TOKEN`, but it does
not work when Node `fetch`, curl, or the ccswap proxy sends it to the real
Anthropic upstream as a bearer token.

`claude setup-token` may produce a long-lived token with different upstream
behavior. The new proposal should compare it explicitly:

```text
A. login accessToken
   Claude Code with CLAUDE_CODE_OAUTH_TOKEN: works
   generic fetch/curl/proxy to Anthropic: 401

B. setup-token token
   Claude Code with CLAUDE_CODE_OAUTH_TOKEN: must be tested
   generic fetch/curl/proxy to Anthropic: must be tested
```

Decision rule:

- If the setup-token token also returns `401` through generic fetch/curl/proxy,
  stop pursuing proxy token swapping.
- If the setup-token token succeeds through generic fetch/curl/proxy, proxy
  mode can be revisited using setup-token enrollment instead of the login
  access token.

Observed setup-token result:

- `claude setup-token` created a one-year token.
- Direct Claude Code child-process auth worked:

  ```text
  CLAUDE_CODE_OAUTH_TOKEN=<setup-token> claude -p "Return exactly ok"
  -> ok
  ```

- A local capture run with the same setup-token produced the expected
  `/v1/messages?beta=true` request, including `x-claude-code-session-id` and
  OAuth beta headers.
- Re-sending that captured request to the real Anthropic upstream with Node
  `fetch` and `Authorization: Bearer <setup-token>` returned:

  ```text
  401 Invalid authentication credentials
  ```

Conclusion: setup-token enrollment does not change the generic forwarding
boundary. The proxy path should remain closed unless a future upstream contract
changes the premise.

This is not a request to retry the same token-only swap with the existing login
access token. That path has already failed. The only useful question here is
whether a different token class exists that is accepted by the real upstream
outside Claude Code's own client runtime. That question has now been answered:
not for the tested `claude setup-token` token.

The generated setup-token is long-lived. It was removed from local temporary
files after the test, but it should be revoked in the Claude/Anthropic account
settings if the provider exposes token revocation.
