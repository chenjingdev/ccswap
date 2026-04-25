import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AccountData } from "./config.js";
import { readJson, writeJson } from "./fs-util.js";

interface ClaudeStatusLineConfig {
  type?: string;
  command?: string;
  padding?: number;
  refreshInterval?: number;
  [key: string]: unknown;
}

interface ClaudeSettings {
  statusLine?: ClaudeStatusLineConfig;
  [key: string]: unknown;
}

function userClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ccswapCliPath(): string {
  return process.env["CCSWAP_CLI"] || process.argv[1] || "ccswap";
}

function buildCaptureCommand(accountName: string, passthroughCommand: string | null): string {
  const parts = [
    shellQuote(process.execPath),
    shellQuote(ccswapCliPath()),
    "usage-capture",
    "--account",
    shellQuote(accountName),
  ];
  if (passthroughCommand) {
    const encoded = Buffer.from(passthroughCommand, "utf-8").toString("base64");
    parts.push("--passthrough", shellQuote(encoded));
  }
  return parts.join(" ");
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  return readJson<ClaudeSettings>(path, {});
}

export function extractSettingsPath(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--settings") {
      const value = args[i + 1];
      return value && !value.startsWith("-") ? value : null;
    }
    if (arg?.startsWith("--settings=")) {
      return arg.slice("--settings=".length) || null;
    }
  }
  return null;
}

export function stripSettingsArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--settings") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--settings=")) continue;
    result.push(arg);
  }
  return result;
}

export function writeUsageCaptureSettings(
  account: AccountData,
  runtimeSettingsPath: string,
  args: string[],
): void {
  const basePath = extractSettingsPath(args) ?? userClaudeSettingsPath();
  const base = readSettings(basePath);
  const original = base.statusLine;
  const originalCommand =
    original?.type === "command" &&
    typeof original.command === "string" &&
    !original.command.includes("usage-capture")
      ? original.command
      : null;
  writeJson(runtimeSettingsPath, {
    ...base,
    statusLine: {
      ...(original ?? {}),
      type: "command",
      command: buildCaptureCommand(account.name, originalCommand),
    },
  });
}

export function withUsageCaptureSettingsArgs(args: string[], settingsPath: string): string[] {
  return [...stripSettingsArgs(args), "--settings", settingsPath];
}

export function readStdinJson(): unknown {
  try {
    const input = readFileSync(0, "utf-8");
    return input ? JSON.parse(input) : null;
  } catch {
    return null;
  }
}
