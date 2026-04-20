import { readFileSync } from "node:fs";
import { platform } from "node:os";

export interface HookSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

interface HookEntry {
  hooks: Array<{ type: string; command: string }>;
  matcher?: string;
}

function shellQuote(value: string): string {
  if (platform() === "win32") {
    if (value.length === 0) return '""';
    if (/^[A-Za-z0-9_\-./=:@%+,\\]+$/.test(value)) return value;
    return `"${value.replace(/"/g, `\\"`)}"`;
  }
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getHookCommandPrefix(): string {
  const override = process.env["CCSWAP_HOOK_CMD"];
  if (override) return override;
  const node = process.execPath;
  const script = process.argv[1] ?? "";
  return `${shellQuote(node)} ${shellQuote(script)}`;
}

export function buildRuntimeHookSettings(runId: string, statePath: string): HookSettings {
  const prefix = getHookCommandPrefix();
  const sessionHook = {
    type: "command",
    command: `${prefix} hook session-start --run-id ${shellQuote(runId)} --state-path ${shellQuote(statePath)}`,
  };
  const promptHook = {
    type: "command",
    command: `${prefix} hook prompt-submit --run-id ${shellQuote(runId)} --state-path ${shellQuote(statePath)}`,
  };
  return {
    hooks: {
      SessionStart: [{ hooks: [sessionHook] }],
      UserPromptSubmit: [{ hooks: [promptHook] }],
    },
  };
}

function mergeSettings(base: HookSettings, extra: HookSettings): HookSettings {
  const merged: HookSettings = JSON.parse(JSON.stringify(base)) as HookSettings;
  for (const [key, value] of Object.entries(extra)) {
    if (key === "hooks" && value && typeof value === "object") {
      const mergedHooks = (merged.hooks ??= {});
      for (const [event, entries] of Object.entries(value as Record<string, HookEntry[]>)) {
        const existing = mergedHooks[event] ?? [];
        mergedHooks[event] = [...existing, ...entries];
      }
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      merged[key] !== null &&
      typeof merged[key] === "object" &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = mergeSettings(merged[key] as HookSettings, value as HookSettings);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function loadSettingsValue(raw: string): HookSettings | null {
  const expanded = raw.startsWith("~") ? raw.replace(/^~/, process.env["HOME"] ?? "~") : raw;
  try {
    const text = readFileSync(expanded, "utf-8");
    return JSON.parse(text) as HookSettings;
  } catch {
    // not a file — maybe inline JSON
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as HookSettings) : null;
  } catch {
    return null;
  }
}

export function injectRuntimeSettings(
  originalArgs: string[],
  runId: string,
  statePath: string,
  settingsPath: string,
  writeFile: (path: string, content: string) => void,
): string[] {
  const args = [...originalArgs];
  const existing: string[] = [];
  let idx = 0;
  while (idx < args.length) {
    if (args[idx] === "--settings" && idx + 1 < args.length) {
      const value = args[idx + 1];
      if (value !== undefined) existing.push(value);
      args.splice(idx, 2);
      continue;
    }
    idx += 1;
  }

  let merged: HookSettings = {};
  for (const raw of existing) {
    const loaded = loadSettingsValue(raw);
    if (loaded) merged = mergeSettings(merged, loaded);
  }
  merged = mergeSettings(merged, buildRuntimeHookSettings(runId, statePath));

  writeFile(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  return [...args, "--settings", settingsPath];
}
