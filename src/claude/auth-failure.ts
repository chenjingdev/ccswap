export type ClaudeAuthFailureKind =
  | "unauthorized"
  | "login_required"
  | "oauth_expired"
  | "invalid_credentials";

export interface ClaudeAuthFailure {
  kind: ClaudeAuthFailureKind;
  reason: string;
  matchedText: string;
}

interface AuthFailurePattern {
  kind: ClaudeAuthFailureKind;
  reason: string;
  pattern: RegExp;
}

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const AUTH_FAILURE_PATTERNS: AuthFailurePattern[] = [
  {
    kind: "unauthorized",
    reason: "401 unauthorized",
    pattern:
      /^(?:error:\s*)?(?:http[- ]?)?401(?:\s+unauthorized)?\.?$|^(?:error:\s*)?unauthorized\.?$|(?:error|api error|authentication|auth|request failed|status(?: code)?)[^\n\r]{0,120}\b(?:401|unauthorized)\b|\b(?:401|unauthorized)\b[^\n\r]{0,120}\b(?:authentication|credentials?|token|login|error)\b/i,
  },
  {
    kind: "invalid_credentials",
    reason: "invalid authentication credentials",
    pattern: /invalid (?:authentication )?credentials|invalid api key|invalid auth/i,
  },
  {
    kind: "oauth_expired",
    reason: "OAuth token expired",
    pattern: /(?:oauth )?token (?:has )?expired|expired (?:oauth )?token/i,
  },
  {
    kind: "login_required",
    reason: "Claude login required",
    pattern: /please (?:log in|login)|not logged in|not authenticated|login required/i,
  },
];

function normalizeChunk(chunk: string): string {
  return chunk.replace(ANSI_PATTERN, "").replace(/\s+/g, " ").trim();
}

export function detectClaudeAuthFailure(chunk: string): ClaudeAuthFailure | null {
  const normalized = normalizeChunk(chunk);
  if (!normalized) return null;
  for (const candidate of AUTH_FAILURE_PATTERNS) {
    const match = normalized.match(candidate.pattern);
    if (!match) continue;
    return {
      kind: candidate.kind,
      reason: candidate.reason,
      matchedText: match[0] ?? normalized,
    };
  }
  return null;
}
