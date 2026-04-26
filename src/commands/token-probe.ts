import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findAccount, loadConfig } from "../core/config.js";
import { getAccountCredential, parseStoredCredential } from "../core/credentials.js";
import { buildClaudeEnv } from "../core/env.js";

export interface TokenProbeOptions {
  infer?: boolean;
}

function exitStatus(status: number | null, signal: NodeJS.Signals | null): number {
  if (typeof status === "number") return status;
  if (signal) return 1;
  return 1;
}

function runWithToken(claudeBin: string, args: string[], token: string, cwd = process.cwd()): number {
  const result = spawnSync(claudeBin, args, {
    cwd,
    env: buildClaudeEnv({ oauthToken: token }),
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[ccswap] failed to run ${claudeBin}: ${result.error.message}`);
    return 1;
  }
  return exitStatus(result.status, result.signal);
}

export function runTokenProbe(name: string, options: TokenProbeOptions = {}): number {
  const config = loadConfig();
  const account = findAccount(config, name);
  if (!account) {
    console.error(`account "${name}" not found`);
    return 1;
  }

  const credential = getAccountCredential(account);
  if (!credential) {
    console.error(`account "${name}" has no saved login. run: ccswap login ${name}`);
    return 1;
  }

  const parsed = parseStoredCredential(credential.secret);
  if (!parsed.access_token) {
    console.error(`account "${name}" has no OAuth access token in its saved login`);
    return 1;
  }

  const authStatus = runWithToken(config.claude_bin, ["auth", "status", "--json"], parsed.access_token);
  if (authStatus !== 0 || !options.infer) return authStatus;

  const scratchCwd = mkdtempSync(join(tmpdir(), "ccswap-token-probe-"));
  try {
    return runWithToken(config.claude_bin, ["-p", "Return exactly ok"], parsed.access_token, scratchCwd);
  } finally {
    rmSync(scratchCwd, { recursive: true, force: true });
  }
}
