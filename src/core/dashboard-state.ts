import { rmSync } from "node:fs";

import { readJson, writeJson } from "./fs-util.js";
import { DASHBOARD_STATE_PATH } from "./paths.js";
import { processIsAlive } from "./runtime.js";

export interface DashboardStateData {
  pid: number;
  started_at: string;
  heartbeat_at: string;
}

interface DashboardStateFile {
  pid?: number;
  started_at?: string;
  heartbeat_at?: string;
}

export interface DashboardStatus {
  running: boolean;
  state: DashboardStateData | null;
}

function normalizeDashboardState(raw: DashboardStateFile): DashboardStateData | null {
  if (typeof raw.pid !== "number" || raw.pid <= 0) return null;
  if (!raw.started_at || !raw.heartbeat_at) return null;
  return {
    pid: raw.pid,
    started_at: String(raw.started_at),
    heartbeat_at: String(raw.heartbeat_at),
  };
}

export function loadDashboardStatus(): DashboardStatus {
  const state = normalizeDashboardState(readJson<DashboardStateFile>(DASHBOARD_STATE_PATH, {}));
  if (!state) return { running: false, state: null };
  return {
    running: processIsAlive(state.pid),
    state,
  };
}

export function writeDashboardHeartbeat(now = new Date()): DashboardStateData {
  const existing = loadDashboardStatus().state;
  const state: DashboardStateData = {
    pid: process.pid,
    started_at: existing?.pid === process.pid ? existing.started_at : now.toISOString(),
    heartbeat_at: now.toISOString(),
  };
  writeJson(DASHBOARD_STATE_PATH, state);
  return state;
}

export function clearDashboardHeartbeat(pid = process.pid): void {
  const state = loadDashboardStatus().state;
  if (state && state.pid !== pid) return;
  try {
    rmSync(DASHBOARD_STATE_PATH, { force: true });
  } catch {
    // ignore
  }
}
