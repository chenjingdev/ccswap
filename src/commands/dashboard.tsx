import { render } from "ink";
import React from "react";

import { clearDashboardHeartbeat, writeDashboardHeartbeat } from "../core/dashboard-state.js";
import { ensureClaudeShim } from "../core/shim.js";
import { App } from "../tui/App.js";
import { runLogin, runLoginNewAccount } from "./login.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function enterFullscreen(): void {
  process.stdout.write(ENTER_ALT_SCREEN);
  process.stdout.write(HIDE_CURSOR);
}

function exitFullscreen(): void {
  process.stdout.write(SHOW_CURSOR);
  process.stdout.write(EXIT_ALT_SCREEN);
}

export async function runDashboard(): Promise<number> {
  const initialConnection = ensureClaudeShim();
  writeDashboardHeartbeat();
  const heartbeat = setInterval(() => {
    writeDashboardHeartbeat();
  }, 2_000);
  const cleanupOnFatal = (): void => {
    clearInterval(heartbeat);
    clearDashboardHeartbeat();
    exitFullscreen();
  };
  process.on("exit", cleanupOnFatal);
  process.on("SIGINT", () => {
    cleanupOnFatal();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanupOnFatal();
    process.exit(143);
  });

  try {
    while (true) {
      let action: { kind: "login"; name: string } | { kind: "add" } | null = null;

      enterFullscreen();
      const { waitUntilExit, unmount } = render(
        React.createElement(App, {
          hasTty: Boolean(process.stdin.isTTY),
          initialConnection,
          onLoginRequested: (name: string) => {
            action = { kind: "login", name };
            unmount();
          },
          onAddRequested: () => {
            action = { kind: "add" };
            unmount();
          },
        }),
        { exitOnCtrlC: true },
      );

      try {
        await waitUntilExit();
      } finally {
        exitFullscreen();
      }

      if (!action) return 0;

      process.stdout.write("\n");
      const a = action as { kind: "login"; name: string } | { kind: "add" };
      if (a.kind === "login") {
        await runLogin(a.name);
      } else {
        await runLoginNewAccount();
      }
    }
  } finally {
    process.off("exit", cleanupOnFatal);
    clearInterval(heartbeat);
    clearDashboardHeartbeat();
  }
}
