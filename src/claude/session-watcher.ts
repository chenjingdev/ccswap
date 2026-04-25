import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { updateRuntimeState } from "../core/runtime.js";

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export interface SessionWatcherOptions {
  runId: string;
  statePath: string;
  launchCwd: string;
  launchedAtMs: number;
  /**
   * When set, the watcher will only accept a jsonl file whose basename equals
   * this UUID. Callers should set this whenever the launched session's id is
   * known up front — either because ccswap injected `--session-id`, or because
   * the user supplied `--session-id` / `--resume <id>`. Without this anchor the
   * watcher falls back to a pre-launch mtime snapshot to guess which transcript
   * belongs to this run, which is vulnerable to collisions when a sibling
   * Claude session is writing to the same cwd.
   */
  expectedSessionId?: string | null;
  pollMs?: number;
  onSessionIdDiscovered?: (sessionId: string) => void;
}

export interface SessionWatcherHandle {
  stop: () => void;
}

export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function claudeProjectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

function projectDirForCwd(cwd: string): string {
  return join(claudeProjectsDir(), encodeClaudeProjectDir(cwd));
}

interface JsonlFileInfo {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

function listSessionJsonlFiles(projectDir: string): JsonlFileInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }
  const out: JsonlFileInfo[] = [];
  for (const name of entries) {
    if (!UUID_JSONL.test(name)) continue;
    const path = join(projectDir, name);
    try {
      const s = statSync(path);
      if (!s.isFile()) continue;
      out.push({
        path,
        sessionId: basename(name, ".jsonl"),
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // ignore
    }
  }
  return out;
}

function verifyCwdInHeader(path: string, expectedCwd: string): boolean {
  try {
    const raw = readFileSync(path, "utf-8");
    const nl = raw.indexOf("\n", 0);
    const header = nl === -1 ? raw : raw.slice(0, nl);
    if (!header) return false;
    const obj = JSON.parse(header) as { cwd?: unknown };
    if (typeof obj.cwd === "string" && obj.cwd === expectedCwd) return true;
    // Header line may not carry cwd (e.g., permission-mode/file-history). Scan
    // a small prefix for the first entry that does.
    const scanEnd = Math.min(raw.length, 8192);
    let idx = nl + 1;
    while (idx > 0 && idx < scanEnd) {
      const next = raw.indexOf("\n", idx);
      const line = (next === -1 ? raw.slice(idx) : raw.slice(idx, next)).trim();
      if (line) {
        try {
          const o = JSON.parse(line) as { cwd?: unknown };
          if (typeof o.cwd === "string") return o.cwd === expectedCwd;
        } catch {
          // skip malformed line
        }
      }
      if (next === -1) break;
      idx = next + 1;
    }
    return false;
  } catch {
    return false;
  }
}

interface ResolveArgs {
  candidates: JsonlFileInfo[];
  launchCwd: string;
  expectedSessionId: string | null;
  baselineMtimes: Map<string, number>;
  launchedAtMs: number;
  knownSessionId: string | null;
}

function pickActiveSession(args: ResolveArgs): JsonlFileInfo | null {
  const { candidates, launchCwd, expectedSessionId, baselineMtimes, launchedAtMs, knownSessionId } = args;

  // Anchor path: caller told us exactly which session to track.
  if (expectedSessionId) {
    const hit = candidates.find((c) => c.sessionId === expectedSessionId);
    if (!hit) return null;
    // Defensive: reject if the on-disk transcript says it belongs to a
    // different cwd (possible if --session-id collided with a prior run in
    // another dir). The verification is a few-KB read, so it is cheap.
    if (!verifyCwdInHeader(hit.path, launchCwd)) return null;
    return hit;
  }

  // Fallback path (typically --continue, where we can't pin the id up front).
  // First: if we previously adopted a session id, keep riding it.
  if (knownSessionId) {
    const hit = candidates.find((c) => c.sessionId === knownSessionId);
    if (hit) return hit;
  }

  // Otherwise, find the file whose mtime advanced past its pre-launch
  // baseline. A brand-new file has no baseline entry and is accepted as long
  // as its mtime is at or past launch time (minus a small grace window for
  // filesystem clock skew). Files whose mtime did not advance are rejected —
  // they belong to prior, unrelated sessions.
  const GRACE_MS = 500;
  const advanced: JsonlFileInfo[] = [];
  for (const c of candidates) {
    const baseline = baselineMtimes.get(c.sessionId);
    if (baseline === undefined) {
      if (c.mtimeMs >= launchedAtMs - GRACE_MS) advanced.push(c);
      continue;
    }
    if (c.mtimeMs > baseline && c.mtimeMs >= launchedAtMs - GRACE_MS) {
      advanced.push(c);
    }
  }
  advanced.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of advanced) {
    if (verifyCwdInHeader(c.path, launchCwd)) return c;
  }
  return null;
}

interface ExtractedPrompt {
  text: string;
  timestamp: string | null;
}

export function extractLastUserPrompt(jsonlPath: string): ExtractedPrompt | null {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return null;
  }
  if (!raw) return null;
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const extracted = tryExtractUserPromptLine(trimmed);
    if (extracted) return extracted;
  }
  return null;
}

function tryExtractUserPromptLine(line: string): ExtractedPrompt | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o["type"] !== "user") return null;
  if (o["isSidechain"] === true) return null;
  if (o["isMeta"] === true) return null;
  const message = o["message"];
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m["role"] !== "user") return null;
  const content = m["content"];
  let text: string | null = null;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string") {
          parts.push(b["text"] as string);
        } else if (b["type"] === "tool_result") {
          // Skip tool results — they flow through user-role turns but aren't prompts.
          return null;
        }
      }
    }
    text = parts.join("\n");
  }
  if (!text) return null;
  const cleaned = stripSyntheticPromptText(text);
  if (!cleaned) return null;
  const timestamp = typeof o["timestamp"] === "string" ? (o["timestamp"] as string) : null;
  return { text: cleaned, timestamp };
}

function stripSyntheticPromptText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Synthetic entries Claude Code persists alongside real prompts.
  if (trimmed.startsWith("<command-name>")) return null;
  if (trimmed.startsWith("<local-command-stdout>")) return null;
  if (trimmed.startsWith("<local-command-stderr>")) return null;
  if (trimmed.startsWith("Caveat:")) return null;
  // Strip leading system-reminder blocks so the stored prompt matches what the
  // user actually typed.
  let body = text;
  while (true) {
    const m = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/.exec(body);
    if (!m) break;
    body = body.slice(m[0].length);
  }
  const finalTrim = body.trim();
  return finalTrim.length > 0 ? finalTrim : null;
}

export function startSessionWatcher(opts: SessionWatcherOptions): SessionWatcherHandle {
  const pollMs = opts.pollMs ?? 400;
  const projectDir = projectDirForCwd(opts.launchCwd);
  const expectedSessionId = opts.expectedSessionId ?? null;

  // Snapshot existing jsonl mtimes so the fallback path can distinguish "file
  // was touched after our launch" from "file was already there and untouched".
  // Only used when expectedSessionId is absent.
  const baselineMtimes = new Map<string, number>();
  if (!expectedSessionId) {
    for (const c of listSessionJsonlFiles(projectDir)) {
      baselineMtimes.set(c.sessionId, c.mtimeMs);
    }
  }

  let stopped = false;
  let knownSessionId: string | null = null;
  let lastPromptSeen: string | null = null;

  const tick = (): void => {
    if (stopped) return;
    try {
      const candidates = listSessionJsonlFiles(projectDir);
      const active = pickActiveSession({
        candidates,
        launchCwd: opts.launchCwd,
        expectedSessionId,
        baselineMtimes,
        launchedAtMs: opts.launchedAtMs,
        knownSessionId,
      });
      if (!active) return;

      if (knownSessionId !== active.sessionId) {
        knownSessionId = active.sessionId;
        updateRuntimeState(opts.statePath, opts.runId, {
          session_id: active.sessionId,
          cwd: opts.launchCwd,
        });
        opts.onSessionIdDiscovered?.(active.sessionId);
      }

      const prompt = extractLastUserPrompt(active.path);
      if (prompt && prompt.text !== lastPromptSeen) {
        lastPromptSeen = prompt.text;
        const armed = !prompt.text.trimStart().startsWith("/");
        updateRuntimeState(opts.statePath, opts.runId, {
          last_prompt: prompt.text,
          last_prompt_at: prompt.timestamp ?? new Date().toISOString(),
          detector_armed: armed,
        });
      }
    } catch {
      // swallow; next tick will retry
    }
  };

  const handle = setInterval(tick, pollMs);
  if (typeof handle.unref === "function") handle.unref();
  // Kick once synchronously so callers don't have to wait a full tick for the
  // initial session file (common with --resume which touches mtime immediately).
  setImmediate(tick);

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
