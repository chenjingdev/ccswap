import { DEFAULT_CLAUDE_BIN, isReplayMode, type ReplayMode } from "./constants.js";
import { readJson, writeJson } from "./fs-util.js";
import {
  CONFIG_PATH,
  defaultKeychainAccount,
  defaultKeychainService,
} from "./paths.js";

export interface AccountData {
  name: string;
  auth_source: "credential";
  auto_swap: boolean;
  keychain_service: string;
  keychain_account: string;
  email: string | null;
  claude_account?: ClaudeAccountInfoData | null;
  auth_error_at?: string | null;
  auth_error_reason?: string | null;
}

export type AuthMode = "keychain_copy" | "oauth_env";

export interface ClaudeAccountInfoData {
  emailAddress: string | null;
  displayName: string | null;
  accountUuid: string | null;
  organizationUuid: string | null;
  organizationName: string | null;
  organizationRole: string | null;
  workspaceRole: string | null;
}

export interface AppConfigData {
  accounts: AccountData[];
  claude_bin: string;
  replay_mode: ReplayMode;
  custom_prompt: string;
  proactive_swap_threshold_pct: number | null;
  auth_mode: AuthMode;
}

export interface ConfigFile {
  accounts?: Array<Partial<AccountData> & { name: string }>;
  claude_bin?: string;
  replay_mode?: string;
  custom_prompt?: string;
  proactive_swap_threshold_pct?: number | null;
  auth_mode?: string;
}

function normalizeThreshold(value: unknown): number | null {
  if (value === null || value === false) return null;
  if (typeof value !== "number" || Number.isNaN(value)) return 95;
  return Math.max(1, Math.min(100, Math.round(value)));
}

function normalizeAuthMode(value: unknown): AuthMode {
  if (value === "oauth_env") return value;
  return "keychain_copy";
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" && record[key] ? record[key] : null;
}

function normalizeClaudeAccountInfo(value: unknown): ClaudeAccountInfoData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const emailAddress = nullableString(record, "emailAddress");
  const displayName = nullableString(record, "displayName");
  const accountUuid = nullableString(record, "accountUuid");
  const organizationUuid = nullableString(record, "organizationUuid");
  const organizationName = nullableString(record, "organizationName");
  const organizationRole = nullableString(record, "organizationRole");
  const workspaceRole = nullableString(record, "workspaceRole");
  if (
    !emailAddress &&
    !displayName &&
    !accountUuid &&
    !organizationUuid &&
    !organizationName &&
    !organizationRole &&
    !workspaceRole
  ) {
    return null;
  }
  return {
    emailAddress,
    displayName,
    accountUuid,
    organizationUuid,
    organizationName,
    organizationRole,
    workspaceRole,
  };
}

export function createAccount(name: string): AccountData {
  return {
    name,
    auth_source: "credential",
    auto_swap: true,
    keychain_service: defaultKeychainService(name),
    keychain_account: defaultKeychainAccount(),
    email: null,
  };
}

function isFolderBackedAccount(raw: Partial<AccountData> & { name: string }): boolean {
  return (
    Object.prototype.hasOwnProperty.call(raw, "claude_config_dir") ||
    raw.auth_source !== "credential"
  );
}

function normalizeAccount(raw: Partial<AccountData> & { name: string }): AccountData {
  const name = raw.name;
  const account: AccountData = {
    name,
    auth_source: "credential",
    auto_swap: Boolean(raw.auto_swap ?? true),
    keychain_service: raw.keychain_service || defaultKeychainService(name),
    keychain_account: raw.keychain_account || defaultKeychainAccount(),
    email: typeof raw.email === "string" && raw.email ? raw.email : null,
    claude_account: normalizeClaudeAccountInfo(raw.claude_account),
  };
  if (typeof raw.auth_error_at === "string" && raw.auth_error_at) {
    account.auth_error_at = raw.auth_error_at;
  }
  if (typeof raw.auth_error_reason === "string" && raw.auth_error_reason) {
    account.auth_error_reason = raw.auth_error_reason;
  }
  return account;
}

function normalizeConfig(data: ConfigFile): AppConfigData {
  const accounts: AccountData[] = [];
  const byEmail = new Map<string, number>();
  for (const rawAccount of data.accounts ?? []) {
    if (isFolderBackedAccount(rawAccount)) continue;
    const account = normalizeAccount(rawAccount);
    const emailKey = account.email?.trim().toLowerCase() ?? null;
    if (emailKey) {
      const existingIndex = byEmail.get(emailKey);
      if (existingIndex !== undefined) {
        continue;
      }
      byEmail.set(emailKey, accounts.length);
    }
    accounts.push(account);
  }
  const replayRaw = data.replay_mode ?? "continue";
  const replay: ReplayMode = isReplayMode(replayRaw) ? replayRaw : "continue";
  return {
    accounts,
    claude_bin: data.claude_bin ?? DEFAULT_CLAUDE_BIN,
    replay_mode: replay,
    custom_prompt: data.custom_prompt ?? "",
    proactive_swap_threshold_pct: normalizeThreshold(data.proactive_swap_threshold_pct),
    auth_mode: normalizeAuthMode(data.auth_mode),
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
