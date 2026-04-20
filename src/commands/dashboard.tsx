import { render } from "ink";
import React from "react";

import { App } from "../tui/App.js";
import { runLogin } from "./login.js";

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

async function waitForEnter(prompt: string): Promise<void> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      if (s.includes("\r") || s.includes("\n") || s === "\u0003") {
        stdin.off("data", onData);
        resolve();
      }
    };
    stdin.on("data", onData);
  });
  if (stdin.isTTY) stdin.setRawMode(wasRaw);
  stdin.pause();
  process.stdout.write("\n");
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
      let loginTarget: string | null = null;

      enterFullscreen();
      const { waitUntilExit, unmount } = render(
        React.createElement(App, {
          hasTty: Boolean(process.stdin.isTTY),
          onLoginRequested: (name: string) => {
            loginTarget = name;
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

      if (!loginTarget) return 0;

      process.stdout.write("\n");
      const code = await runLogin(loginTarget);
      if (code !== 0) {
        process.stderr.write(`\n[ccswap] login exited with code ${code}.\n`);
      }
      await waitForEnter("\n[ccswap] Press Enter to return to the dashboard...");
    }
  } finally {
    process.off("exit", cleanupOnFatal);
  }
}
