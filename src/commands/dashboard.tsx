import { render } from "ink";
import React from "react";

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
  const cleanupOnFatal = (): void => exitFullscreen();
  process.on("exit", cleanupOnFatal);
  process.on("SIGINT", () => {
    exitFullscreen();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    exitFullscreen();
    process.exit(143);
  });

  try {
    while (true) {
      let action: { kind: "login"; name: string } | { kind: "add" } | null = null;

      enterFullscreen();
      const { waitUntilExit, unmount } = render(
        React.createElement(App, {
          hasTty: Boolean(process.stdin.isTTY),
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
  }
}
