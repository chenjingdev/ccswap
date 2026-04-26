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

export interface UsageCaptureSettingsOptions {
  userSettingsPath?: string;
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

function buildCaptureCommand(
  accountName: string,
  passthroughCommand: string | null,
): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseInlineSettings(value: string): ClaudeSettings {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readSettingsSource(value: string): ClaudeSettings {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) return parseInlineSettings(trimmed);
  return readSettings(value);
}

function mergeSettings(base: ClaudeSettings, override: ClaudeSettings): ClaudeSettings {
  const merged: ClaudeSettings = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isRecord(existing) && isRecord(value)) {
      merged[key] = mergeSettings(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function loadEffectiveSettings(args: string[], options: UsageCaptureSettingsOptions): ClaudeSettings {
  const userSettings = readSettings(options.userSettingsPath ?? userClaudeSettingsPath());
  const cliSettingsSource = extractSettingsPath(args);
  if (!cliSettingsSource) return userSettings;
  return mergeSettings(userSettings, readSettingsSource(cliSettingsSource));
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
  options: UsageCaptureSettingsOptions = {},
): void {
  const base = loadEffectiveSettings(args, options);
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
