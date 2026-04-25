import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { findAccount, loadConfig } from "../core/config.js";
import {
  accountUsageCachePath,
  captureStatusLineUsage,
  type StatusLineRateLimitsInput,
} from "../core/usage.js";

export interface UsageCaptureOptions {
  account: string;
  passthrough?: string;
}

function decodePassthrough(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return Buffer.from(value, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

function runPassthrough(command: string | null, input: string): number {
  if (!command) return 0;
  const result = spawnSync(command, {
    shell: true,
    input,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 0;
}

export function runUsageCapture(options: UsageCaptureOptions): number {
  const rawInput = readFileSync(0, "utf-8");

  try {
    const config = loadConfig();
    const account = findAccount(config, options.account);
    if (process.env["CCSWAP_USAGE_CAPTURE_DEBUG"]) {
      process.stderr.write(`[ccswap] usage-capture account=${options.account} found=${account ? "yes" : "no"}\n`);
    }
    if (account) {
      const parsedInput = JSON.parse(rawInput) as unknown;
      if (parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)) {
        const ok = captureStatusLineUsage(
          accountUsageCachePath(account),
          null,
          parsedInput as StatusLineRateLimitsInput,
        );
        if (process.env["CCSWAP_USAGE_CAPTURE_DEBUG"]) {
          process.stderr.write(`[ccswap] usage-capture wrote=${ok ? "yes" : "no"}\n`);
        }
      }
    }
  } catch (err) {
    if (process.env["CCSWAP_USAGE_CAPTURE_DEBUG"]) {
      process.stderr.write(`[ccswap] usage-capture error=${err instanceof Error ? err.message : String(err)}\n`);
    }
    // The status line should never disappear because capture failed.
  }

  return runPassthrough(decodePassthrough(options.passthrough), rawInput);
}
