import { DEFAULT_CLAUDE_BIN, isReplayMode, type ReplayMode } from "./constants.js";
import { readJson, writeJson } from "./fs-util.js";
import {
  CONFIG_PATH,
  defaultKeychainAccount,
  defaultKeychainService,
} from "./paths.js";

export interface AccountData {
  name: string;
  auto_swap: boolean;
  keychain_service: string;
  keychain_account: string;
  email: string | null;
}

export interface AppConfigData {
  accounts: AccountData[];
  claude_bin: string;
  replay_mode: ReplayMode;
  custom_prompt: string;
  proactive_swap_threshold_pct: number | null;
}

export interface ConfigFile {
  accounts?: Array<Partial<AccountData> & { name: string; enabled?: boolean; claude_config_dir?: string }>;
  claude_bin?: string;
  replay_mode?: string;
  custom_prompt?: string;
  proactive_swap_threshold_pct?: number | null;
}

function normalizeThreshold(value: unknown): number | null {
  if (value === null || value === false) return null;
  if (typeof value !== "number" || Number.isNaN(value)) return 95;
  return Math.max(1, Math.min(100, Math.round(value)));
}

export function createAccount(name: string): AccountData {
  return {
    name,
    auto_swap: true,
    keychain_service: defaultKeychainService(name),
    keychain_account: defaultKeychainAccount(),
    email: null,
  };
}

function normalizeAccount(raw: Partial<AccountData> & { name: string; enabled?: boolean; claude_config_dir?: string }): AccountData {
  const name = raw.name;
  const autoSwap = raw.auto_swap ?? raw.enabled ?? true;
  return {
    name,
    auto_swap: Boolean(autoSwap),
    keychain_service: raw.keychain_service || defaultKeychainService(name),
    keychain_account: raw.keychain_account || defaultKeychainAccount(),
    email: typeof raw.email === "string" && raw.email ? raw.email : null,
  };
}

function normalizeConfig(data: ConfigFile): AppConfigData {
  const accounts: AccountData[] = [];
  for (const rawAccount of data.accounts ?? []) {
    const account = normalizeAccount(rawAccount);
    accounts.push(account);
  }
  const replayRaw = data.replay_mode ?? "last_prompt";
  const replay: ReplayMode = isReplayMode(replayRaw) ? replayRaw : "last_prompt";
  return {
    accounts,
    claude_bin: data.claude_bin ?? DEFAULT_CLAUDE_BIN,
    replay_mode: replay,
    custom_prompt: data.custom_prompt ?? "",
    proactive_swap_threshold_pct: normalizeThreshold(data.proactive_swap_threshold_pct),
  };
}

export function loadConfig(): AppConfigData {
  const raw = readJson<ConfigFile>(CONFIG_PATH, { accounts: [] });
  return normalizeConfig(raw);
}

export function saveConfig(config: AppConfigData): void {
  writeJson(CONFIG_PATH, config);
}

export function findAccount(config: AppConfigData, name: string): AccountData | undefined {
  return config.accounts.find((a) => a.name === name);
}
