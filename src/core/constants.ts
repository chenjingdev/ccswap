export const DEFAULT_CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const CCSWAP_KEYCHAIN_PREFIX = "ccswap-account";

export const REPLAY_MODES = ["last_prompt", "continue", "custom_prompt"] as const;
export type ReplayMode = (typeof REPLAY_MODES)[number];
export const DEFAULT_CONTINUE_PROMPT = "Continue.";

export function isReplayMode(value: string): value is ReplayMode {
  return (REPLAY_MODES as readonly string[]).includes(value);
}

export const LIMIT_PATTERNS: RegExp[] = [
  /you['’]ve hit your limit/i,
  /you['’]ve reached your limit/i,
  /you['’]ve reached your usage limit/i,
  /usage limit reached/i,
  /max usage limit/i,
  /api error:\s*rate limit reached/i,
  /\brate limit reached\b/i,
  /\brate limited\b/i,
  /\bquota exhausted\b/i,
  /\b429 too many requests\b/i,
];

export const OPTIONS_WITH_VALUE = new Set<string>([
  "--add-dir",
  "--agent",
  "--agents",
  "--allowedTools",
  "--allowed-tools",
  "--append-system-prompt",
  "--betas",
  "--debug",
  "--debug-file",
  "--disallowedTools",
  "--disallowed-tools",
  "--effort",
  "--fallback-model",
  "--file",
  "--from-pr",
  "--input-format",
  "--json-schema",
  "--max-budget-usd",
  "--mcp-config",
  "--model",
  "--name",
  "--output-format",
  "--permission-mode",
  "--plugin-dir",
  "--remote-control-session-name-prefix",
  "--resume",
  "-r",
  "--session-id",
  "--setting-sources",
  "--settings",
  "--system-prompt",
  "--tools",
  "--worktree",
  "-w",
  "-n",
]);
