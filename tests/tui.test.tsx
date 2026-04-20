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
    process.env.XDG_CONFIG_HOME = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it("renders empty state when no accounts exist", async () => {
    const { App } = await import("../src/tui/App.js");
    const onLogin = vi.fn();
    const { lastFrame, unmount } = render(
      React.createElement(App, { onLoginRequested: onLogin, hasTty: false }),
    );
    const frame = lastFrame();
    expect(frame).toContain("ccswap");
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
      React.createElement(App, { onLoginRequested: () => {}, hasTty: false }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("work");
    expect(frame).toContain("side");
    expect(frame).toContain("★");
    expect(frame).toContain("no login");
    unmount();
  });

  it("switches to sessions screen with Tab", async () => {
    const { App } = await import("../src/tui/App.js");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, hasTty: true }),
    );
    stdin.write("\t"); // Tab
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No active Claude sessions");
    unmount();
  });

  it("opens add-account modal on pressing 'a' and submits", async () => {
    const { App } = await import("../src/tui/App.js");
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { onLoginRequested: () => {}, hasTty: true }),
    );
    stdin.write("a");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("Add account");
    stdin.write("myacc");
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\r"); // Enter
    await new Promise((r) => setTimeout(r, 40));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("myacc");
    expect(frame).toContain("Added myacc");
    unmount();
  });
});
