import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

import { loadConfig, saveConfig } from "./config.js";

export const SHIM_MARKER = "# ccswap claude connector";
const LEGACY_SHIM_MARKER = "# ccswap claude shim";

export interface ShimInstallOptions {
  shimPath?: string;
  realClaudePath?: string;
  ccswapBin?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  argv1?: string;
}

export interface ShimInstallResult {
  shimPath: string;
  backupPath: string | null;
  realClaudePath: string;
  ccswapBin: string;
  alreadyInstalled: boolean;
}

export interface ShimStatus {
  shimPath: string;
  installed: boolean;
  pathCommand: string | null;
  onPath: boolean;
  realClaudePath: string | null;
  backupPath: string | null;
  ccswapBin: string | null;
  configClaudeBin: string;
}

export type EnsureClaudeShimKind =
  | "connected"
  | "installed"
  | "path_conflict"
  | "backup_conflict"
  | "unsupported"
  | "error";

export interface EnsureClaudeShimResult {
  kind: EnsureClaudeShimKind;
  status: ShimStatus;
  message: string;
  install?: ShimInstallResult;
  error?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(delimiter).filter(Boolean);
}

export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const names = platform() === "win32"
    ? [command, `${command}.cmd`, `${command}.exe`]
    : [command];
  for (const dir of pathEntries(env)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function preferredUserShimPath(): string {
  return join(homedir(), ".local", "bin", "claude");
}

function isUnsafeShimTarget(path: string): boolean {
  const normalized = resolve(path);
  return normalized.includes("/Applications/") || normalized.includes(".app/Contents/");
}

export function defaultShimPath(env: NodeJS.ProcessEnv = process.env): string {
  const pathCommand = findOnPath("claude", env);
  if (pathCommand && (isCcswapShim(pathCommand) || !isUnsafeShimTarget(pathCommand))) {
    return pathCommand;
  }
  return preferredUserShimPath();
}

function defaultCcswapBin(env: NodeJS.ProcessEnv, argv1 = process.argv[1]): string {
  return env.CCSWAP_CLI || findOnPath("ccswap", env) || argv1 || "ccswap";
}

function backupPathFor(shimPath: string): string {
  return `${shimPath}.ccswap-real`;
}

function uniqueBackupPath(shimPath: string): string {
  const base = backupPathFor(shimPath);
  if (!existsSync(base)) return base;
  let idx = 1;
  while (existsSync(`${base}.${idx}`)) idx += 1;
  return `${base}.${idx}`;
}

export function isCcswapShim(path: string): boolean {
  try {
    const raw = readFileSync(path, "utf-8");
    return raw.includes(SHIM_MARKER) || raw.includes(LEGACY_SHIM_MARKER);
  } catch {
    return false;
  }
}

function extractShimValue(path: string, name: string): string | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const match = raw.match(new RegExp(`^${name}=(.+)$`, "m"));
    if (!match) return null;
    const value = match[1]!.trim();
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/'\\''/g, "'");
    }
    return value;
  } catch {
    return null;
  }
}

function resolveExistingClaude(shimPath: string, backupPath: string): string | null {
  if (!existsSync(shimPath)) return null;
  if (isCcswapShim(shimPath)) return extractShimValue(shimPath, "CCSWAP_REAL_CLAUDE");
  const stat = lstatSync(shimPath);
  if (stat.isSymbolicLink()) return realpathSync(shimPath);
  return backupPath;
}

function resolveClaudeFromPath(
  shimPath: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const pathCommand = findOnPath("claude", env);
  if (!pathCommand) return null;
  if (resolve(pathCommand) === resolve(shimPath)) return null;
  try {
    return realpathSync(pathCommand);
  } catch {
    return resolve(pathCommand);
  }
}

function isCmuxClaudeWrapper(path: string): boolean {
  try {
    const raw = readFileSync(path, "utf-8");
    return raw.includes("cmux claude wrapper") && raw.includes("find_real_claude");
  } catch {
    return false;
  }
}

function resolveDelegatedClaude(pathCommand: string, env: NodeJS.ProcessEnv): string | null {
  if (!isCmuxClaudeWrapper(pathCommand)) return null;
  const selfDir = dirname(resolve(pathCommand));
  for (const dir of pathEntries(env)) {
    if (resolve(dir) === selfDir) continue;
    const candidate = join(dir, "claude");
    if (existsSync(candidate)) return resolve(candidate);
  }
  return null;
}

function commandPathReachesShim(
  pathCommand: string | null,
  shimPath: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!pathCommand) return false;
  const normalizedShim = resolve(shimPath);
  if (resolve(pathCommand) === normalizedShim) return true;
  return resolveDelegatedClaude(pathCommand, env) === normalizedShim;
}

function writeShim(shimPath: string, realClaudePath: string, ccswapBin: string): void {
  mkdirSync(dirname(shimPath), { recursive: true });
  const script = [
    "#!/bin/sh",
    SHIM_MARKER,
    `CCSWAP_REAL_CLAUDE=${shellQuote(realClaudePath)}`,
    `CCSWAP_BIN=${shellQuote(ccswapBin)}`,
    'if [ "${CCSWAP_BYPASS:-}" = "1" ]; then',
    '  exec "$CCSWAP_REAL_CLAUDE" "$@"',
    "fi",
    "export CCSWAP_REAL_CLAUDE",
    "export CCSWAP_SHIM_ACTIVE=1",
    'exec "$CCSWAP_BIN" claude "$@"',
    "",
  ].join("\n");
  writeFileSync(shimPath, script, { encoding: "utf-8", mode: 0o755 });
  if (platform() !== "win32") chmodSync(shimPath, 0o755);
}

export function installClaudeShim(options: ShimInstallOptions = {}): ShimInstallResult {
  if (platform() === "win32") {
    throw new Error("ccswap connector install currently supports POSIX shells only.");
  }

  const env = options.env ?? process.env;
  const shimPath = resolve(options.shimPath ?? defaultShimPath(env));
  const ccswapBin = resolve(options.ccswapBin ?? defaultCcswapBin(env, options.argv1));
  const backupPath = backupPathFor(shimPath);
  const alreadyInstalled = existsSync(shimPath) && isCcswapShim(shimPath);
  let realClaudePath = options.realClaudePath
    ? resolve(options.realClaudePath)
    : resolveExistingClaude(shimPath, backupPath) ?? resolveClaudeFromPath(shimPath, env);

  if (!realClaudePath) {
    throw new Error(`Could not find an existing claude command to wrap at ${shimPath}. Pass --real <path>.`);
  }
  if (resolve(realClaudePath) === shimPath && !alreadyInstalled) {
    realClaudePath = backupPath;
  }
  const plannedBackupFromCurrentCommand = !options.realClaudePath
    && !alreadyInstalled
    && existsSync(shimPath)
    && !isCcswapShim(shimPath)
    && resolve(realClaudePath) === resolve(backupPath);
  if (!existsSync(realClaudePath) && !alreadyInstalled && !plannedBackupFromCurrentCommand) {
    throw new Error(`Resolved real Claude binary does not exist: ${realClaudePath}`);
  }

  let movedBackupPath: string | null = null;
  if (!alreadyInstalled && existsSync(shimPath)) {
    movedBackupPath = options.force ? uniqueBackupPath(shimPath) : backupPath;
    if (existsSync(movedBackupPath)) {
      throw new Error(`Backup already exists: ${movedBackupPath}. Use --force to create a numbered backup.`);
    }
    renameSync(shimPath, movedBackupPath);
    if (!options.realClaudePath && realClaudePath === backupPath) {
      realClaudePath = movedBackupPath;
    }
  }

  writeShim(shimPath, realClaudePath, ccswapBin);
  const config = loadConfig();
  config.claude_bin = realClaudePath;
  saveConfig(config);

  return {
    shimPath,
    backupPath: movedBackupPath,
    realClaudePath,
    ccswapBin,
    alreadyInstalled,
  };
}

export function getShimStatus(options: ShimInstallOptions = {}): ShimStatus {
  const env = options.env ?? process.env;
  const shimPath = resolve(options.shimPath ?? defaultShimPath(env));
  const pathCommand = findOnPath("claude", env);
  const installed = existsSync(shimPath) && isCcswapShim(shimPath);
  const backupPath = existsSync(backupPathFor(shimPath)) ? backupPathFor(shimPath) : null;
  const config = loadConfig();
  const onPath = installed && commandPathReachesShim(pathCommand, shimPath, env);
  return {
    shimPath,
    installed,
    pathCommand,
    onPath,
    realClaudePath: installed ? extractShimValue(shimPath, "CCSWAP_REAL_CLAUDE") : null,
    backupPath,
    ccswapBin: installed ? extractShimValue(shimPath, "CCSWAP_BIN") : null,
    configClaudeBin: config.claude_bin,
  };
}

export function ensureClaudeShim(options: ShimInstallOptions = {}): EnsureClaudeShimResult {
  let status = getShimStatus(options);

  if (status.installed && status.onPath) {
    return {
      kind: "connected",
      status,
      message: `Plain claude is connected via ${status.shimPath}.`,
    };
  }

  if (platform() === "win32") {
    return {
      kind: "unsupported",
      status,
      message: "Plain claude auto-connect currently supports POSIX shells only.",
    };
  }

  if (status.installed && !status.onPath) {
    return {
      kind: "path_conflict",
      status,
      message: status.pathCommand
        ? `Plain claude resolves to ${status.pathCommand} before the ccswap connector at ${status.shimPath}.`
        : `The ccswap connector exists at ${status.shimPath}, but that directory is not on PATH.`,
    };
  }

  const env = options.env ?? process.env;
  const shimPath = resolve(options.shimPath ?? defaultShimPath(env));
  const pathCommand = findOnPath("claude", env);
  if (pathCommand && resolve(pathCommand) !== shimPath) {
    return {
      kind: "path_conflict",
      status,
      message: `Plain claude resolves to ${pathCommand}; ccswap would install at ${shimPath}.`,
    };
  }

  const backupPath = backupPathFor(shimPath);
  if (existsSync(shimPath) && !isCcswapShim(shimPath) && existsSync(backupPath) && !options.force) {
    return {
      kind: "backup_conflict",
      status,
      message: `Backup already exists at ${backupPath}; not overwriting ${shimPath} automatically.`,
    };
  }

  if (!options.realClaudePath && !resolveClaudeFromPath(shimPath, env) && !resolveExistingClaude(shimPath, backupPath)) {
    return {
      kind: "unsupported",
      status,
      message: "Could not find a real claude command to connect safely.",
    };
  }

  try {
    const install = installClaudeShim({ ...options, force: options.force === true });
    status = getShimStatus(options);
    return {
      kind: "installed",
      status,
      install,
      message: `Plain claude connected via ${install.shimPath}.`,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      status: getShimStatus(options),
      message: error,
      error,
    };
  }
}

export function removeClaudeShim(options: ShimInstallOptions = {}): ShimInstallResult {
  const env = options.env ?? process.env;
  const shimPath = resolve(options.shimPath ?? defaultShimPath(env));
  if (!existsSync(shimPath) || !isCcswapShim(shimPath)) {
    throw new Error(`${shimPath} is not a ccswap connector.`);
  }
  const realClaudePath = extractShimValue(shimPath, "CCSWAP_REAL_CLAUDE");
  const ccswapBin = extractShimValue(shimPath, "CCSWAP_BIN") ?? defaultCcswapBin(env, options.argv1);
  if (!realClaudePath) throw new Error("Could not read real Claude path from connector.");
  rmSync(shimPath);
  const backupPath = backupPathFor(shimPath);
  if (existsSync(backupPath)) {
    renameSync(backupPath, shimPath);
  }
  const config = loadConfig();
  if (config.claude_bin === realClaudePath) {
    config.claude_bin = basename(shimPath);
    saveConfig(config);
  }
  return {
    shimPath,
    backupPath: existsSync(shimPath) ? backupPath : null,
    realClaudePath,
    ccswapBin,
    alreadyInstalled: true,
  };
}
