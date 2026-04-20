import { Entry, findCredentials } from "@napi-rs/keyring";

import { CLAUDE_KEYCHAIN_SERVICE } from "./constants.js";
import type { AccountData } from "./config.js";
import { defaultKeychainAccount } from "./paths.js";

export interface StoredCredential {
  service: string;
  account: string;
  secret: string;
}

export interface ParsedCredential {
  subscription_type: string | null;
  access_token: string | null;
}

function safeGet(service: string, account: string): string | null {
  try {
    return new Entry(service, account).getPassword();
  } catch {
    return null;
  }
}

function safeFindFirst(service: string): { account: string; password: string } | null {
  try {
    const rows = findCredentials(service);
    if (rows.length === 0) return null;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export function getStandardClaudeCredential(): StoredCredential | null {
  const direct = safeGet(CLAUDE_KEYCHAIN_SERVICE, defaultKeychainAccount());
  if (direct !== null) {
    return {
      service: CLAUDE_KEYCHAIN_SERVICE,
      account: defaultKeychainAccount(),
      secret: direct,
    };
  }
  const found = safeFindFirst(CLAUDE_KEYCHAIN_SERVICE);
  if (found) {
    return {
      service: CLAUDE_KEYCHAIN_SERVICE,
      account: found.account,
      secret: found.password,
    };
  }
  return null;
}

export function getAccountCredential(account: AccountData): StoredCredential | null {
  if (!account.keychain_service) return null;
  const direct = safeGet(account.keychain_service, account.keychain_account || defaultKeychainAccount());
  if (direct !== null) {
    return {
      service: account.keychain_service,
      account: account.keychain_account || defaultKeychainAccount(),
      secret: direct,
    };
  }
  const found = safeFindFirst(account.keychain_service);
  if (found) {
    return {
      service: account.keychain_service,
      account: found.account,
      secret: found.password,
    };
  }
  return null;
}

export function storeAccountCredential(account: AccountData, credential: StoredCredential): boolean {
  if (!credential.secret) return false;
  const user = credential.account || defaultKeychainAccount();
  account.keychain_account = user;
  try {
    new Entry(account.keychain_service, user).setPassword(credential.secret);
    return true;
  } catch {
    return false;
  }
}

export function activateAccountCredential(account: AccountData): boolean {
  const credential = getAccountCredential(account);
  if (credential === null) return false;
  const user = credential.account || defaultKeychainAccount();
  try {
    new Entry(CLAUDE_KEYCHAIN_SERVICE, user).setPassword(credential.secret);
    return true;
  } catch {
    return false;
  }
}

export function deleteAccountCredential(account: AccountData): void {
  if (!account.keychain_service) return;
  try {
    new Entry(account.keychain_service, account.keychain_account || defaultKeychainAccount()).deletePassword();
  } catch {
    // ignore missing entries
  }
}

export function parseStoredCredential(secret: string | null | undefined): ParsedCredential {
  if (!secret) return { subscription_type: null, access_token: null };
  try {
    const payload = JSON.parse(secret) as unknown;
    if (typeof payload !== "object" || payload === null) {
      return { subscription_type: null, access_token: null };
    }
    const oauth = (payload as Record<string, unknown>)["claudeAiOauth"];
    if (typeof oauth !== "object" || oauth === null) {
      return { subscription_type: null, access_token: null };
    }
    const record = oauth as Record<string, unknown>;
    return {
      subscription_type: typeof record["subscriptionType"] === "string" ? (record["subscriptionType"] as string) : null,
      access_token: typeof record["accessToken"] === "string" ? (record["accessToken"] as string) : null,
    };
  } catch {
    return { subscription_type: null, access_token: null };
  }
}
