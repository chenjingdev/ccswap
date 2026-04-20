import { DEFAULT_CLAUDE_BIN, isReplayMode, type ReplayMode } from "./constants.js";
import { readJson, writeJson } from "./fs-util.js";
import {
  CONFIG_PATH,
  defaultAccountDir,
  defaultKeychainAccount,
  defaultKeychainService,
} from "./paths.js";

export interface AccountData {
  name: string;
  claude_config_dir: string;
  auto_swap: boolean;
  keychain_service: string;
  keychain_account: string;
}

export interface AppConfigData {
  accounts: AccountData[];
  claude_bin: string;
  replay_mode: ReplayMode;
  custom_prompt: string;
}

export interface ConfigFile {
  accounts?: Array<Partial<AccountData> & { name: string; enabled?: boolean }>;
  claude_bin?: string;
  replay_mode?: string;
  custom_prompt?: string;
}

export function createAccount(name: string): AccountData {
  return {
    name,
    claude_config_dir: defaultAccountDir(name),
    auto_swap: true,
    keychain_service: defaultKeychainService(name),
    keychain_account: defaultKeychainAccount(),
  };
}

function normalizeAccount(raw: Partial<AccountData> & { name: string; enabled?: boolean }): AccountData {
  const name = raw.name;
  const configDir = raw.claude_config_dir ?? defaultAccountDir(name);
  const autoSwap = raw.auto_swap ?? raw.enabled ?? true;
  return {
    name,
    claude_config_dir: configDir,
    auto_swap: Boolean(autoSwap),
    keychain_service: raw.keychain_service || defaultKeychainService(name),
    keychain_account: raw.keychain_account || defaultKeychainAccount(),
  };
}

function normalizeConfig(data: ConfigFile): AppConfigData {
  const seenDirs = new Set<string>();
  const accounts: AccountData[] = [];
  for (const rawAccount of data.accounts ?? []) {
    const account = normalizeAccount(rawAccount);
    if (seenDirs.has(account.claude_config_dir)) {
      account.claude_config_dir = defaultAccountDir(account.name);
    }
    seenDirs.add(account.claude_config_dir);
    accounts.push(account);
  }
  const replayRaw = data.replay_mode ?? "last_prompt";
  const replay: ReplayMode = isReplayMode(replayRaw) ? replayRaw : "last_prompt";
  return {
    accounts,
    claude_bin: data.claude_bin ?? DEFAULT_CLAUDE_BIN,
    replay_mode: replay,
    custom_prompt: data.custom_prompt ?? "",
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
