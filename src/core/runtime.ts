import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { readJson, writeJson } from "./fs-util.js";
import { RUNTIME_DIR } from "./paths.js";

export interface SessionRuntimeState {
  run_id: string;
  session_id: string | null;
  last_prompt: string | null;
  last_prompt_at: string | null;
  last_assistant_stop_at: string | null;
  detector_armed: boolean;
  cwd: string | null;
  active_account: string | null;
  replay_mode: string;
  custom_prompt: string | null;
  started_at: string | null;
  ccswap_pid: number | null;
  claude_pid: number | null;
  swap_pending: boolean;
  swap_reason: "proactive_usage" | "hard_limit" | null;
  swap_requested_at: string | null;
  swap_wait_until: string | null;
  swap_wait_reason: "usage_reset" | null;
  requested_account: string | null;
  requested_reason: "manual_session_switch" | null;
  requested_at: string | null;
  last_activity_at: string | null;
  safe_to_restart: boolean;
  auth_error_account?: string | null;
  auth_error_reason?: string | null;
  auth_error_at?: string | null;
}

interface RuntimeStateFile extends Partial<SessionRuntimeState> {}

export function runtimeStatePath(runId: string): string {
  return join(RUNTIME_DIR, `${runId}.json`);
}

function defaultState(runId: string): SessionRuntimeState {
  return {
    run_id: runId,
    session_id: null,
    last_prompt: null,
    last_prompt_at: null,
    last_assistant_stop_at: null,
    detector_armed: false,
    cwd: null,
    active_account: null,
    replay_mode: "continue",
    custom_prompt: null,
    started_at: null,
    ccswap_pid: null,
    claude_pid: null,
    swap_pending: false,
    swap_reason: null,
    swap_requested_at: null,
    swap_wait_until: null,
    swap_wait_reason: null,
    requested_account: null,
    requested_reason: null,
    requested_at: null,
    last_activity_at: null,
    safe_to_restart: false,
    auth_error_account: null,
    auth_error_reason: null,
    auth_error_at: null,
  };
}

function normalizeSwapReason(value: unknown): SessionRuntimeState["swap_reason"] {
  if (value === "proactive_usage" || value === "hard_limit") return value;
  return null;
}

function normalizeRequestedReason(value: unknown): SessionRuntimeState["requested_reason"] {
  if (value === "manual_session_switch") return value;
  return null;
}

function normalizeSwapWaitReason(value: unknown): SessionRuntimeState["swap_wait_reason"] {
  if (value === "usage_reset") return value;
  return null;
}

export function loadRuntimeState(path: string, runId: string): SessionRuntimeState {
  const raw = readJson<RuntimeStateFile>(path, {});
  const fallback = defaultState(runId);
  return {
    run_id: String(raw.run_id ?? runId),
    session_id: raw.session_id ? String(raw.session_id) : null,
    last_prompt: raw.last_prompt ? String(raw.last_prompt) : null,
    last_prompt_at: raw.last_prompt_at ? String(raw.last_prompt_at) : null,
    last_assistant_stop_at: raw.last_assistant_stop_at ? String(raw.last_assistant_stop_at) : null,
    detector_armed: Boolean(raw.detector_armed ?? false),
    cwd: raw.cwd ? String(raw.cwd) : null,
    active_account: raw.active_account ? String(raw.active_account) : null,
    replay_mode: String(raw.replay_mode ?? fallback.replay_mode),
    custom_prompt: raw.custom_prompt ? String(raw.custom_prompt) : null,
    started_at: raw.started_at ? String(raw.started_at) : null,
    ccswap_pid: typeof raw.ccswap_pid === "number" ? raw.ccswap_pid : null,
    claude_pid: typeof raw.claude_pid === "number" ? raw.claude_pid : null,
    swap_pending: Boolean(raw.swap_pending ?? fallback.swap_pending),
    swap_reason: normalizeSwapReason(raw.swap_reason),
    swap_requested_at: raw.swap_requested_at ? String(raw.swap_requested_at) : null,
    swap_wait_until: raw.swap_wait_until ? String(raw.swap_wait_until) : null,
    swap_wait_reason: normalizeSwapWaitReason(raw.swap_wait_reason),
    requested_account: raw.requested_account ? String(raw.requested_account) : null,
    requested_reason: normalizeRequestedReason(raw.requested_reason),
    requested_at: raw.requested_at ? String(raw.requested_at) : null,
    last_activity_at: raw.last_activity_at ? String(raw.last_activity_at) : null,
    safe_to_restart: Boolean(raw.safe_to_restart ?? fallback.safe_to_restart),
    auth_error_account: raw.auth_error_account ? String(raw.auth_error_account) : null,
    auth_error_reason: raw.auth_error_reason ? String(raw.auth_error_reason) : null,
    auth_error_at: raw.auth_error_at ? String(raw.auth_error_at) : null,
  };
}

export function saveRuntimeState(path: string, state: SessionRuntimeState): void {
  writeJson(path, state);
}

export function updateRuntimeState(
  path: string,
  runId: string,
  patch: Partial<SessionRuntimeState>,
): SessionRuntimeState {
  const current = loadRuntimeState(path, runId);
  const bag: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) bag[key] = value;
  }
  const next = bag as unknown as SessionRuntimeState;
  saveRuntimeState(path, next);
  return next;
}

export function processIsAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err) {
      // EPERM means the process exists but we can't signal it — still alive.
      return (err as { code?: string }).code === "EPERM";
    }
    return false;
  }
}

function removeRuntimeArtifacts(runId: string): void {
  // Legacy .settings.json from the old hook-injection strategy is cleaned up
  // alongside the state file in case an older ccswap left one behind.
  const paths = [
    runtimeStatePath(runId),
    join(RUNTIME_DIR, `${runId}.settings.json`),
  ];
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
  }
}

export function cleanupStaleRuntimeSessions(): void {
  let entries: string[];
  try {
    entries = readdirSync(RUNTIME_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith(".json") || name.endsWith(".settings.json")) continue;
    const runId = name.slice(0, -".json".length);
    const path = join(RUNTIME_DIR, name);
    const state = loadRuntimeState(path, runId);
    if (processIsAlive(state.ccswap_pid)) continue;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const ageSeconds = Math.max(0, (now - mtime) / 1000);
    if (state.ccswap_pid === null && ageSeconds < 15) continue;
    removeRuntimeArtifacts(runId);
  }
}

export function listRuntimeSessions(): SessionRuntimeState[] {
  cleanupStaleRuntimeSessions();

  let entries: string[];
  try {
    entries = readdirSync(RUNTIME_DIR);
  } catch {
    return [];
  }

  const sessions: SessionRuntimeState[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.endsWith(".settings.json")) continue;
    const runId = name.slice(0, -".json".length);
    const path = join(RUNTIME_DIR, name);
    const state = loadRuntimeState(path, runId);
    if (!processIsAlive(state.ccswap_pid)) continue;
    if (!processIsAlive(state.claude_pid) && !isRecentlyStarting(state)) continue;
    sessions.push(state);
  }

  return sessions.sort((a, b) => timestampMs(b.started_at) - timestampMs(a.started_at));
}

function isRecentlyStarting(state: SessionRuntimeState): boolean {
  if (state.claude_pid !== null) return false;
  const started = timestampMs(state.started_at);
  if (started <= 0) return false;
  return Date.now() - started < 15_000;
}

function timestampMs(iso: string | null): number {
  if (!iso) return 0;
  const value = new Date(iso).getTime();
  return Number.isNaN(value) ? 0 : value;
}
