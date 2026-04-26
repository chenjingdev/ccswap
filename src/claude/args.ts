import { DEFAULT_CONTINUE_PROMPT, isReplayMode, OPTIONS_WITH_VALUE } from "../core/constants.js";
import type { SessionRuntimeState } from "../core/runtime.js";

export interface SplitResult {
  args: string[];
  prompt: string | null;
}

export function splitPromptFromArgs(args: string[]): SplitResult {
  if (args.length === 0) return { args: [], prompt: null };
  const result: string[] = [];
  const positional: string[] = [];
  let expectValue = false;
  for (const token of args) {
    if (expectValue) {
      result.push(token);
      expectValue = false;
      continue;
    }
    if (token === "--") {
      result.push(token);
      continue;
    }
    if (token.startsWith("-")) {
      result.push(token);
      const head = token.split("=")[0]!;
      if (OPTIONS_WITH_VALUE.has(token) || (!token.includes("=") && token.startsWith("--") && OPTIONS_WITH_VALUE.has(head))) {
        expectValue = !token.includes("=");
      }
      continue;
    }
    positional.push(token);
    result.push(token);
  }
  if (positional.length === 0) return { args: result, prompt: null };
  const prompt = positional[positional.length - 1]!;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i] === prompt) {
      result.splice(i, 1);
      break;
    }
  }
  return { args: result, prompt };
}

export function buildResumeArgs(
  originalArgs: string[],
  runtime: SessionRuntimeState,
  disableAutoContinue = false,
  includeReplayPrompt = true,
): string[] {
  if (disableAutoContinue) return originalArgs;
  if (originalArgs.some((arg) => arg === "-p" || arg === "--print")) return originalArgs;
  const sessionId = runtime.session_id;
  if (!sessionId) return originalArgs;

  const { args: filtered, prompt: originalPrompt } = splitPromptFromArgs(originalArgs);
  // Walk the filtered args while tracking whether each token is a flag or the
  // value of a previous value-taking flag. Only flag-position tokens are
  // candidates for session-directive stripping — value-position tokens pass
  // through untouched so a legitimate `--append-system-prompt --resume=foo`
  // (where `--resume=foo` is literal system-prompt text) is not mangled.
  const resumeFiltered: string[] = [];
  let expectValue = false;
  for (let i = 0; i < filtered.length; i += 1) {
    const arg = filtered[i]!;
    if (expectValue) {
      resumeFiltered.push(arg);
      expectValue = false;
      continue;
    }
    if (arg === "-c" || arg === "--continue") continue;
    if (arg === "-r" || arg === "--resume" || arg === "--session-id") {
      // Only swallow the following token as this flag's value when it does not
      // look like another flag; otherwise we'd eat unrelated options like
      // `--resume --fork-session`.
      const next = filtered[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        i += 1;
      }
      continue;
    }
    // Inline `--flag=value` form — Claude Code accepts it, so we must strip it
    // too or the rebuilt launch ends up with both the ccswap-supplied session
    // anchor and the user's stale one.
    if (arg.startsWith("--resume=") || arg.startsWith("--session-id=")) continue;
    resumeFiltered.push(arg);
    // If this flag is value-taking and was not written in `--flag=value` form,
    // the next token belongs to it as a value — don't treat it as a fresh flag.
    if (
      arg.startsWith("-") &&
      !arg.includes("=") &&
      (OPTIONS_WITH_VALUE.has(arg) ||
        (arg.startsWith("--") && OPTIONS_WITH_VALUE.has(arg.split("=")[0]!)))
    ) {
      expectValue = true;
    }
  }

  const replayMode = isReplayMode(runtime.replay_mode) ? runtime.replay_mode : "last_prompt";
  const resumeArgs = ["--resume", sessionId, ...resumeFiltered];

  let promptToSend: string | null = null;
  if (includeReplayPrompt) {
    if (replayMode === "last_prompt") {
      promptToSend = runtime.last_prompt ?? originalPrompt;
    } else if (replayMode === "continue") {
      promptToSend = DEFAULT_CONTINUE_PROMPT;
    } else if (replayMode === "custom_prompt") {
      promptToSend = runtime.custom_prompt;
    }
  }
  if (promptToSend) resumeArgs.push(promptToSend);
  return resumeArgs;
}

export function normalizeCliArgs(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  if (argv[0] !== "claude") return argv;
  if (argv.length === 1) return ["run"];
  return ["run", "--", ...argv.slice(1)];
}

export type ResolvedSessionDirective =
  | { kind: "user-provided"; sessionId: string }
  | { kind: "user-continue" }
  | { kind: "none" };

/**
 * Inspect the user-supplied launch args for any pre-existing session directive
 * that would fix or resume a specific Claude session. Returns:
 *   - "user-provided" with the id when --session-id / --resume / -r specify one
 *   - "user-continue" when -c / --continue is present without an explicit id
 *   - "none" when ccswap is free to invent its own --session-id
 */
export function resolveSessionDirective(args: string[]): ResolvedSessionDirective {
  let continueSeen = false;
  let expectValue = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (expectValue) {
      // Token is the value of the previous value-taking flag — do not treat it
      // as a session directive even if it happens to look like one (e.g.
      // `--append-system-prompt --resume=foo`).
      expectValue = false;
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      return { kind: "user-provided", sessionId: arg.slice("--session-id=".length) };
    }
    if (arg.startsWith("--resume=")) {
      return { kind: "user-provided", sessionId: arg.slice("--resume=".length) };
    }
    if (arg === "--session-id" || arg === "--resume" || arg === "-r") {
      // Accept the next token as the id only when it does not look like a
      // separate option (e.g. `--session-id --debug`).
      if (i + 1 < args.length) {
        const next = args[i + 1]!;
        if (!next.startsWith("-")) {
          return { kind: "user-provided", sessionId: next };
        }
      }
      // Bare form: `--resume` / `-r` on their own ask Claude to open its
      // interactive resume picker; `--session-id` on its own is invalid for
      // Claude but clearly signals the user did not want ccswap to invent its
      // own id. In either case, defer to Claude's own session selection (same
      // as `-c`) — ccswap must not inject a fresh --session-id, and the
      // watcher will adopt whichever transcript Claude ends up writing to via
      // the mtime-snapshot fallback.
      continueSeen = true;
      continue;
    }
    if (arg === "-c" || arg === "--continue") {
      continueSeen = true;
      continue;
    }
    // Record whether this token consumes a value so the next iteration skips
    // the value-position token instead of inspecting it as a fresh flag.
    if (
      arg.startsWith("-") &&
      !arg.includes("=") &&
      (OPTIONS_WITH_VALUE.has(arg) ||
        (arg.startsWith("--") && OPTIONS_WITH_VALUE.has(arg.split("=")[0]!)))
    ) {
      expectValue = true;
    }
  }
  return continueSeen ? { kind: "user-continue" } : { kind: "none" };
}
