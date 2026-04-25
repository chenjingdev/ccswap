import type { AccountData, AppConfigData } from "./config.js";
import { createAccount, findAccount, saveConfig } from "./config.js";
import { deleteAccountCredential, getAccountCredential } from "./credentials.js";

export function addAccount(config: AppConfigData, name: string): AccountData {
  if (findAccount(config, name)) {
    throw new Error(`account "${name}" already exists`);
  }
  const account = createAccount(name);
  config.accounts.push(account);
  saveConfig(config);
  return account;
}

export function deriveUniqueAccountName(config: AppConfigData, hint: string | null): string {
  const base = (hint ?? "").toLowerCase().trim() || "account";
  const existing = new Set(config.accounts.map((a) => a.name));
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
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
