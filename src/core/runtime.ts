import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { readJson, writeJson } from "./fs-util.js";
import { RUNTIME_DIR } from "./paths.js";

export interface SessionRuntimeState {
  run_id: string;
  session_id: string | null;
  last_prompt: string | null;
  last_prompt_at: string | null;
  detector_armed: boolean;
  cwd: string | null;
  active_account: string | null;
  replay_mode: string;
  custom_prompt: string | null;
  started_at: string | null;
  claude_pid: number | null;
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
    detector_armed: false,
    cwd: null,
    active_account: null,
    replay_mode: "last_prompt",
    custom_prompt: null,
    started_at: null,
    claude_pid: null,
  };
}

export function loadRuntimeState(path: string, runId: string): SessionRuntimeState {
  const raw = readJson<RuntimeStateFile>(path, {});
  const fallback = defaultState(runId);
  return {
    run_id: String(raw.run_id ?? runId),
    session_id: raw.session_id ? String(raw.session_id) : null,
    last_prompt: raw.last_prompt ? String(raw.last_prompt) : null,
    last_prompt_at: raw.last_prompt_at ? String(raw.last_prompt_at) : null,
    detector_armed: Boolean(raw.detector_armed ?? false),
    cwd: raw.cwd ? String(raw.cwd) : null,
    active_account: raw.active_account ? String(raw.active_account) : null,
    replay_mode: String(raw.replay_mode ?? fallback.replay_mode),
    custom_prompt: raw.custom_prompt ? String(raw.custom_prompt) : null,
    started_at: raw.started_at ? String(raw.started_at) : null,
    claude_pid: typeof raw.claude_pid === "number" ? raw.claude_pid : null,
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
    if (processIsAlive(state.claude_pid)) continue;
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const ageSeconds = Math.max(0, (now - mtime) / 1000);
    if (state.claude_pid === null && ageSeconds < 15) continue;
    removeRuntimeArtifacts(runId);
  }
}

export interface RuntimeSessionView {
  path: string;
  state: SessionRuntimeState;
  mtime: number;
}

export function listRuntimeSessions(): RuntimeSessionView[] {
  cleanupStaleRuntimeSessions();
  let entries: string[];
  try {
    entries = readdirSync(RUNTIME_DIR);
  } catch {
    return [];
  }
  const views: RuntimeSessionView[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json") || name.endsWith(".settings.json")) continue;
    const runId = name.slice(0, -".json".length);
    const path = join(RUNTIME_DIR, name);
    const state = loadRuntimeState(path, runId);
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    views.push({ path, state, mtime });
  }
  views.sort((a, b) => b.mtime - a.mtime);
  return views;
}
