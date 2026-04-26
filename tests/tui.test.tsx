import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

describe("App TUI", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-tui-"));
    vi.resetModules();
    process.env.CCSWAP_CONFIG_DIR = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.CCSWAP_CONFIG_DIR;
    vi.doUnmock("../src/core/credentials.js");
    vi.doUnmock("../src/core/shim.js");
  });

  it("renders empty state when no accounts exist", async () => {
    const { App } = await import("../src/tui/App.js");
    const onLogin = vi.fn();
    const { lastFrame, unmount } = render(
      React.createElement(App, { onLoginRequested: onLogin, onAddRequested: () => {}, hasTty: false }),
    );
    const frame = lastFrame();
    expect(frame).toContain("CCSWAP");
    expect(frame).toContain("No accounts yet");
    unmount();
  });

  it("renders account rows with active marker and status", async () => {
    const { loadConfig } = await import("../src/core/config.js");
    const { addAccount } = await import("../src/core/accounts.js");
    const { loadState, saveState } = await import("../src/core/state.js");

    const cfg = loadConfig();
    addAccount(cfg, "work");
    addAccount(cfg, "side");

    const st = loadState();
    st.active_account = "work";
    saveState(st);

    const { App } = await import("../src/tui/App.js");
    const { lastFrame, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: false }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("work");
    expect(frame).toContain("side");
    // Active account shows a star marker.
    expect(frame).toContain("★");
    expect(frame).toContain("ACCOUNTS");
    expect(frame).toContain("Usage(5h)");
    expect(frame).toContain("Usage(7d)");
    // New layout: no-login accounts show "login needed" in the usage column.
    expect(frame).toContain("login needed");
    unmount();
  });

  it("shows the first logged-in account as the effective active default", async () => {
    vi.doMock("../src/core/credentials.js", () => ({
      deleteAccountCredential: vi.fn(),
      getAccountCredential: vi.fn((account) =>
        account.name === "work" ? { service: "svc", account: "acct", secret: "secret" } : null,
      ),
      parseStoredCredential: vi.fn(() => ({ subscription_type: "max" })),
    }));

    const { loadConfig } = await import("../src/core/config.js");
    const { addAccount } = await import("../src/core/accounts.js");
    const cfg = loadConfig();
    addAccount(cfg, "work");
    addAccount(cfg, "side");

    const { App } = await import("../src/tui/App.js");
    const { lastFrame, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: false }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("active work");
    expect(frame).toContain("★");
    unmount();
  });

  it("shows saved accounts with auth failures as re-login required", async () => {
    vi.doMock("../src/core/credentials.js", () => ({
      deleteAccountCredential: vi.fn(),
      getAccountCredential: vi.fn(() => ({ service: "svc", account: "acct", secret: "secret" })),
      parseStoredCredential: vi.fn(() => ({ subscription_type: "max" })),
    }));
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [
        {
          name: "work",
          auth_source: "credential",
          auto_swap: true,
          keychain_service: "ccswap-account:work",
          keychain_account: "acct",
          email: "work@example.com",
          auth_error_at: "2026-04-26T00:00:00.000Z",
          auth_error_reason: "401 unauthorized",
        },
      ],
    });

    const { App } = await import("../src/tui/App.js");
    const { lastFrame, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: false }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("re-login required");
    expect(frame).toContain("401 unauthorized");
    expect(frame).toContain("excluded · re-login required");
    unmount();
  });

  it("switches to sessions settings screen", async () => {
    const { App } = await import("../src/tui/App.js");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("SESSIONS");
    expect(frame).toContain("Default replay");
    expect(frame).toContain("Custom prompt");
    unmount();
  });

  it("auto-repairs the plain claude connection without a user shortcut", async () => {
    const disconnected = {
      shimPath: "/tmp/claude",
      installed: false,
      pathCommand: null,
      onPath: false,
      realClaudePath: null,
      backupPath: null,
      ccswapBin: null,
      configClaudeBin: "claude",
    };
    const connected = {
      ...disconnected,
      installed: true,
      onPath: true,
      realClaudePath: "/tmp/real-claude",
      ccswapBin: "/tmp/ccswap",
    };
    const ensureClaudeShim = vi.fn(() => ({
      kind: "installed",
      status: connected,
      message: "Plain claude connected via /tmp/claude.",
    }));
    vi.doMock("../src/core/shim.js", () => ({
      getShimStatus: vi.fn(() => disconnected),
      ensureClaudeShim,
    }));

    const { App } = await import("../src/tui/App.js");
    const { lastFrame, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(ensureClaudeShim).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Plain claude connected");
    expect(lastFrame()).not.toContain("c Connect");
    unmount();
  });

  it("shows ccswap-managed live Claude sessions on the sessions screen", async () => {
    const { runtimeStatePath, saveRuntimeState } = await import("../src/core/runtime.js");
    saveRuntimeState(runtimeStatePath("live-run"), {
      run_id: "live-run",
      session_id: "session-live-123456",
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/Users/chenjing/dev/stock-ml",
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

    const { App } = await import("../src/tui/App.js");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("work");
    expect(frame).toContain("> work");
    expect(frame).toContain("/Users/chenjing/dev/stock-ml");
    expect(frame).toContain("running");
    expect(frame).toContain("Replay mode");
    unmount();
  });

  it("moves the selected live session with arrow keys", async () => {
    const { runtimeStatePath, saveRuntimeState } = await import("../src/core/runtime.js");
    for (const [runId, cwd, startedAt] of [
      ["old-run", "/tmp/old", "2026-04-24T00:00:00.000Z"],
      ["new-run", "/tmp/new", "2026-04-25T00:00:00.000Z"],
    ] as const) {
      saveRuntimeState(runtimeStatePath(runId), {
        run_id: runId,
        session_id: runId,
        last_prompt: null,
        last_prompt_at: null,
        detector_armed: false,
        cwd,
        active_account: runId,
        replay_mode: "continue",
        custom_prompt: null,
        started_at: startedAt,
        ccswap_pid: process.pid,
        claude_pid: process.pid,
        swap_pending: false,
        swap_reason: null,
        swap_requested_at: null,
        last_activity_at: null,
        safe_to_restart: false,
      });
    }

    const { App } = await import("../src/tui/App.js");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("> new-run");

    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("> old-run");
    unmount();
  });

  it("updates replay mode from the sessions screen", async () => {
    const { loadConfig } = await import("../src/core/config.js");
    const { App } = await import("../src/tui/App.js");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("Default replay");
    expect(lastFrame()).toContain("Continue only");
    stdin.write("m");
    await new Promise((r) => setTimeout(r, 20));
    expect(loadConfig().replay_mode).toBe("custom_prompt");
    unmount();
  });

  it("updates replay mode only for the selected live session", async () => {
    const { loadConfig } = await import("../src/core/config.js");
    const { loadRuntimeState, runtimeStatePath, saveRuntimeState } = await import("../src/core/runtime.js");
    for (const [runId, startedAt] of [
      ["old-run", "2026-04-24T00:00:00.000Z"],
      ["new-run", "2026-04-25T00:00:00.000Z"],
    ] as const) {
      saveRuntimeState(runtimeStatePath(runId), {
        run_id: runId,
        session_id: runId,
        last_prompt: null,
        last_prompt_at: null,
        detector_armed: false,
        cwd: `/tmp/${runId}`,
        active_account: runId,
        replay_mode: "last_prompt",
        custom_prompt: null,
        started_at: startedAt,
        ccswap_pid: process.pid,
        claude_pid: process.pid,
        swap_pending: false,
        swap_reason: null,
        swap_requested_at: null,
        last_activity_at: null,
        safe_to_restart: false,
      });
    }

    const { App } = await import("../src/tui/App.js");
    const { stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\u001B[B");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("m");
    await new Promise((r) => setTimeout(r, 20));

    expect(loadRuntimeState(runtimeStatePath("old-run"), "old-run").replay_mode).toBe("continue");
    expect(loadRuntimeState(runtimeStatePath("new-run"), "new-run").replay_mode).toBe("last_prompt");
    expect(loadConfig().replay_mode).toBe("continue");
    unmount();
  });

  it("persists a selected live session account switch request from the sessions screen", async () => {
    vi.doMock("../src/core/credentials.js", () => ({
      deleteAccountCredential: vi.fn(),
      getAccountCredential: vi.fn((account) => ({
        service: `svc-${account.name}`,
        account: "acct",
        secret: "secret",
      })),
      parseStoredCredential: vi.fn(() => ({ subscription_type: "max" })),
    }));

    const { loadConfig } = await import("../src/core/config.js");
    const { addAccount } = await import("../src/core/accounts.js");
    const { loadRuntimeState, runtimeStatePath, saveRuntimeState } = await import("../src/core/runtime.js");
    const cfg = loadConfig();
    addAccount(cfg, "work");
    addAccount(cfg, "side");
    saveRuntimeState(runtimeStatePath("live-run"), {
      run_id: "live-run",
      session_id: "live-run",
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/tmp/live",
      active_account: "work",
      replay_mode: "last_prompt",
      custom_prompt: null,
      started_at: "2026-04-25T00:00:00.000Z",
      ccswap_pid: process.pid,
      claude_pid: process.pid,
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      requested_account: null,
      requested_reason: null,
      requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
    });

    const { App } = await import("../src/tui/App.js");
    const { stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("s");
    await new Promise((r) => setTimeout(r, 20));

    const state = loadRuntimeState(runtimeStatePath("live-run"), "live-run");
    expect(state.requested_account).toBe("side");
    expect(state.requested_reason).toBe("manual_session_switch");
    expect(state.requested_at).toBeTruthy();
    unmount();
  });

  it("saves the selected live session custom prompt without touching defaults", async () => {
    const { loadConfig } = await import("../src/core/config.js");
    const { loadRuntimeState, runtimeStatePath, saveRuntimeState } = await import("../src/core/runtime.js");
    saveRuntimeState(runtimeStatePath("live-run"), {
      run_id: "live-run",
      session_id: "live-run",
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/tmp/live",
      active_account: "work",
      replay_mode: "last_prompt",
      custom_prompt: "existing session prompt",
      started_at: "2026-04-25T00:00:00.000Z",
      ccswap_pid: process.pid,
      claude_pid: process.pid,
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
    });

    const { App } = await import("../src/tui/App.js");
    const { stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("p");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r");
    await new Promise((r) => setTimeout(r, 20));

    const state = loadRuntimeState(runtimeStatePath("live-run"), "live-run");
    expect(state.replay_mode).toBe("custom_prompt");
    expect(state.custom_prompt).toBe("existing session prompt");
    expect(loadConfig().custom_prompt).toBe("");
    unmount();
  });

  it("triggers onAddRequested on pressing 'a'", async () => {
    const { App } = await import("../src/tui/App.js");
    const onAdd = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: onAdd, hasTty: true }),
    );
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(onAdd).toHaveBeenCalledTimes(1);
    unmount();
  });
});
