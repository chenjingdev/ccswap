import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AccountData, AppConfigData } from "./config.js";
import { createAccount, findAccount, saveConfig } from "./config.js";
import { deleteAccountCredential, getAccountCredential } from "./credentials.js";
import { defaultAccountDir, defaultKeychainService } from "./paths.js";

const CLAUDE_CONFIG_SUBDIRS = [
  "logs",
  "projects",
  "todos",
  "shell-snapshots",
  "file-history",
  "debug",
  "session-env",
];

export function ensureAccountDir(account: AccountData): void {
  mkdirSync(account.claude_config_dir, { recursive: true });
  for (const sub of CLAUDE_CONFIG_SUBDIRS) {
    mkdirSync(join(account.claude_config_dir, sub), { recursive: true });
  }
}

export function addAccount(config: AppConfigData, name: string): AccountData {
  if (findAccount(config, name)) {
    throw new Error(`account "${name}" already exists`);
  }
  const account = createAccount(name);
  config.accounts.push(account);
  saveConfig(config);
  ensureAccountDir(account);
  return account;
}

export function renameAccount(config: AppConfigData, oldName: string, newName: string): AccountData {
  if (oldName === newName) {
    const existing = findAccount(config, oldName);
    if (!existing) throw new Error(`account "${oldName}" not found`);
    return existing;
  }
  if (findAccount(config, newName)) {
    throw new Error(`account "${newName}" already exists`);
  }
  const account = findAccount(config, oldName);
  if (!account) throw new Error(`account "${oldName}" not found`);

  const wasDefaultDir = account.claude_config_dir === defaultAccountDir(oldName);
  account.name = newName;
  if (wasDefaultDir) {
    account.claude_config_dir = defaultAccountDir(newName);
  }
  if (
    !account.keychain_service ||
    account.keychain_service === defaultKeychainService(oldName)
  ) {
    account.keychain_service = defaultKeychainService(newName);
  }
  saveConfig(config);
  ensureAccountDir(account);
  return account;
}

export function removeAccount(config: AppConfigData, name: string): void {
  const idx = config.accounts.findIndex((a) => a.name === name);
  if (idx === -1) throw new Error(`account "${name}" not found`);
  const account = config.accounts[idx]!;
  deleteAccountCredential(account);
  config.accounts.splice(idx, 1);
  saveConfig(config);
}

export interface AccountStatus {
  logged_in: boolean;
  subscription_type: string | null;
}

export function getAccountStatus(account: AccountData): AccountStatus {
  const credential = getAccountCredential(account);
  if (!credential) {
    return { logged_in: false, subscription_type: null };
  }
  // Subscription type parsing belongs in credentials module; keep status slim here.
  return { logged_in: true, subscription_type: null };
}
