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
  });

  it("renders empty state when no accounts exist", async () => {
    const { App } = await import("../src/tui/App.js");
    const onLogin = vi.fn();
    const { lastFrame, unmount } = render(
      React.createElement(App, { onLoginRequested: onLogin, hasTty: false }),
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
    // New layout: no-login accounts show "login needed" in the usage column.
    expect(frame).toContain("login needed");
    unmount();
  });

  it("switches to sessions screen with Tab", async () => {
    const { App } = await import("../src/tui/App.js");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, onAddRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t"); // Tab
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("SESSIONS");
    expect(frame).toContain("No live ccswap sessions");
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
