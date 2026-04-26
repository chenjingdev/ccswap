import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("runtime state", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-runtime-"));
    vi.resetModules();
    process.env.CCSWAP_CONFIG_DIR = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.CCSWAP_CONFIG_DIR;
  });

  it("loads legacy state files without swap fields", async () => {
    const { writeJson } = await import("../src/core/fs-util.js");
    const { loadRuntimeState, runtimeStatePath } = await import("../src/core/runtime.js");

    const path = runtimeStatePath("legacy-run");
    writeJson(path, {
      run_id: "legacy-run",
      session_id: "session-1",
      active_account: "work",
      replay_mode: "last_prompt",
      claude_pid: 123,
    });

    const state = loadRuntimeState(path, "legacy-run");

    expect(state.swap_pending).toBe(false);
    expect(state.swap_reason).toBeNull();
    expect(state.swap_requested_at).toBeNull();
    expect(state.requested_account).toBeNull();
    expect(state.requested_reason).toBeNull();
    expect(state.requested_at).toBeNull();
    expect(state.last_activity_at).toBeNull();
    expect(state.safe_to_restart).toBe(false);
    expect(state.ccswap_pid).toBeNull();
    expect(state.active_account).toBe("work");
  });

  it("records proactive pending state and clears it before the next launch", async () => {
    const { updateRuntimeState, loadRuntimeState, runtimeStatePath } = await import("../src/core/runtime.js");

    const path = runtimeStatePath("run-pending");
    const requestedAt = "2026-04-25T00:00:00.000Z";
    updateRuntimeState(path, "run-pending", {
      active_account: "work",
      swap_pending: true,
      swap_reason: "proactive_usage",
      swap_requested_at: requestedAt,
      last_activity_at: requestedAt,
      safe_to_restart: false,
    });

    const pending = loadRuntimeState(path, "run-pending");
    expect(pending.swap_pending).toBe(true);
    expect(pending.swap_reason).toBe("proactive_usage");
    expect(pending.swap_requested_at).toBe(requestedAt);
    expect(pending.safe_to_restart).toBe(false);

    updateRuntimeState(path, "run-pending", {
      active_account: "backup",
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
    });

    const cleared = loadRuntimeState(path, "run-pending");
    expect(cleared.active_account).toBe("backup");
    expect(cleared.swap_pending).toBe(false);
    expect(cleared.swap_reason).toBeNull();
    expect(cleared.swap_requested_at).toBeNull();
    expect(cleared.last_activity_at).toBeNull();
    expect(cleared.safe_to_restart).toBe(false);
  });

  it("lists live runtime sessions and hides stale ones", async () => {
    const { listRuntimeSessions, saveRuntimeState, runtimeStatePath } = await import("../src/core/runtime.js");

    saveRuntimeState(runtimeStatePath("live-run"), {
      run_id: "live-run",
      session_id: "session-live",
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/tmp/live",
      active_account: "work",
      replay_mode: "continue",
      custom_prompt: null,
      started_at: "2026-04-25T00:00:00.000Z",
      ccswap_pid: process.pid,
      claude_pid: process.pid,
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
    });
    saveRuntimeState(runtimeStatePath("stale-run"), {
      run_id: "stale-run",
      session_id: "session-stale",
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/tmp/stale",
      active_account: "side",
      replay_mode: "last_prompt",
      custom_prompt: null,
      started_at: "2026-04-24T00:00:00.000Z",
      ccswap_pid: 999_999_998,
      claude_pid: 999_999_999,
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
    });

    const sessions = listRuntimeSessions();

    expect(sessions.map((session) => session.run_id)).toEqual(["live-run"]);
    expect(sessions[0]?.cwd).toBe("/tmp/live");
  });

  it("hides sessions when the ccswap runner is gone even if Claude is still alive", async () => {
    const { listRuntimeSessions, saveRuntimeState, runtimeStatePath } = await import("../src/core/runtime.js");

    saveRuntimeState(runtimeStatePath("orphan-run"), {
      run_id: "orphan-run",
      session_id: "session-orphan",
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/tmp/orphan",
      active_account: "work",
      replay_mode: "continue",
      custom_prompt: null,
      started_at: "2026-04-25T00:00:00.000Z",
      ccswap_pid: 999_999_998,
      claude_pid: process.pid,
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
    });

    expect(listRuntimeSessions()).toEqual([]);
  });

  it("keeps runtime artifacts while the ccswap runner is relaunching Claude", async () => {
    const {
      cleanupStaleRuntimeSessions,
      runtimeStatePath,
      saveRuntimeState,
    } = await import("../src/core/runtime.js");

    const statePath = runtimeStatePath("relaunch-run");
    const settingsPath = statePath.replace(/\.json$/, ".settings.json");
    saveRuntimeState(statePath, {
      run_id: "relaunch-run",
      session_id: "session-relaunch",
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/tmp/relaunch",
      active_account: "work",
      replay_mode: "continue",
      custom_prompt: null,
      started_at: "2026-04-25T00:00:00.000Z",
      ccswap_pid: process.pid,
      claude_pid: 999_999_999,
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
    });
    writeFileSync(settingsPath, "{}\n", { mode: 0o600 });

    cleanupStaleRuntimeSessions();

    expect(existsSync(statePath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
  });

  it("records dashboard heartbeat and clears only the owning pid", async () => {
    const {
      clearDashboardHeartbeat,
      loadDashboardStatus,
      writeDashboardHeartbeat,
    } = await import("../src/core/dashboard-state.js");

    const first = writeDashboardHeartbeat(new Date("2026-04-25T00:00:00.000Z"));
    expect(first.pid).toBe(process.pid);

    const running = loadDashboardStatus();
    expect(running.running).toBe(true);
    expect(running.state?.pid).toBe(process.pid);
    expect(running.state?.heartbeat_at).toBe("2026-04-25T00:00:00.000Z");

    clearDashboardHeartbeat(process.pid + 1);
    expect(loadDashboardStatus().state).not.toBeNull();

    clearDashboardHeartbeat(process.pid);
    expect(loadDashboardStatus().running).toBe(false);
    expect(loadDashboardStatus().state).toBeNull();
  });
});
