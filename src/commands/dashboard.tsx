import { render } from "ink";
import React from "react";

import { App } from "../tui/App.js";
import { runLogin } from "./login.js";

export async function runDashboard(): Promise<number> {
  let loginTarget: string | null = null;

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

  await waitUntilExit();

  if (loginTarget) {
    process.stdout.write("\n");
    const code = await runLogin(loginTarget);
    return code;
  }

  return 0;
}
