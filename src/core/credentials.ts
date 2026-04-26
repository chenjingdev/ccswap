import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { Entry, findCredentials } from "@napi-rs/keyring";

import { CLAUDE_KEYCHAIN_SERVICE } from "./constants.js";
import type { AccountData, ClaudeAccountInfoData } from "./config.js";
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

const IS_DARWIN = platform() === "darwin";

function darwinFindPassword(service: string, account: string): string | null {
  const r = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  return r.stdout.replace(/\n$/, "");
}

function darwinFindAnyForService(
  service: string,
): { account: string; password: string } | null {
  const meta = spawnSync(
    "security",
    ["find-generic-password", "-s", service],
    { encoding: "utf8" },
  );
  if (meta.status !== 0) return null;
  const acctMatch = meta.stdout.match(/"acct"<blob>="([^"]*)"/);
  if (!acctMatch || acctMatch[1] === undefined) return null;
  const account = acctMatch[1];
  const pw = spawnSync(
    "security",
    ["find-generic-password", "-s", service, "-a", account, "-w"],
    { encoding: "utf8" },
  );
  if (pw.status !== 0) return null;
  return { account, password: pw.stdout.replace(/\n$/, "") };
}

function darwinSetPassword(service: string, account: string, secret: string): boolean {
  const r = spawnSync("security", [
    "add-generic-password",
    "-U",
    "-a",
    account,
    "-s",
    service,
    "-w",
    secret,
  ]);
  return r.status === 0;
}

function darwinDeletePassword(service: string, account: string): void {
  spawnSync("security", [
    "delete-generic-password",
    "-s",
    service,
    "-a",
    account,
  ]);
}

const getCache = new Map<string, string | null>();
const findCache = new Map<string, { account: string; password: string } | null>();

function getCacheKey(service: string, account: string): string {
  return `${service}\x00${account}`;
}

function invalidateCacheFor(service: string, account: string): void {
  getCache.delete(getCacheKey(service, account));
  findCache.delete(service);
}

export function invalidateStandardClaudeCredentialCache(): void {
  findCache.delete(CLAUDE_KEYCHAIN_SERVICE);
  const prefix = `${CLAUDE_KEYCHAIN_SERVICE}\x00`;
  for (const key of Array.from(getCache.keys())) {
    if (key.startsWith(prefix)) getCache.delete(key);
  }
}

function safeGet(service: string, account: string): string | null {
  const key = getCacheKey(service, account);
  if (getCache.has(key)) return getCache.get(key)!;
  let value: string | null;
  if (IS_DARWIN) {
    value = darwinFindPassword(service, account);
  } else {
    try {
      value = new Entry(service, account).getPassword();
    } catch {
      value = null;
    }
  }
  getCache.set(key, value);
  return value;
}

function safeFindFirst(service: string): { account: string; password: string } | null {
  if (findCache.has(service)) return findCache.get(service)!;
  let value: { account: string; password: string } | null;
  if (IS_DARWIN) {
    value = darwinFindAnyForService(service);
  } else {
    try {
      const rows = findCredentials(service);
      value = rows.length === 0 ? null : (rows[0] ?? null);
    } catch {
      value = null;
    }
  }
  findCache.set(service, value);
  if (value) {
    getCache.set(getCacheKey(service, value.account), value.password);
  }
  return value;
}

function safeSet(service: string, account: string, secret: string): boolean {
  invalidateCacheFor(service, account);
  let ok: boolean;
  if (IS_DARWIN) {
    ok = darwinSetPassword(service, account, secret);
  } else {
    try {
      new Entry(service, account).setPassword(secret);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (ok) {
    getCache.set(getCacheKey(service, account), secret);
  }
  return ok;
}

function safeDelete(service: string, account: string): void {
  invalidateCacheFor(service, account);
  if (IS_DARWIN) {
    darwinDeletePassword(service, account);
    return;
  }
  try {
    new Entry(service, account).deletePassword();
  } catch {
    // ignore missing entries
  }
}

function claudeJsonPath(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) return join(override, ".claude.json");
  return join(homedir(), ".claude.json");
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" && record[key] ? record[key] : null;
}

function readClaudeAccountInfo(value: unknown): ClaudeAccountInfoData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  return {
    emailAddress: nullableString(rec, "emailAddress"),
    displayName: nullableString(rec, "displayName"),
    accountUuid: nullableString(rec, "accountUuid"),
    organizationUuid: nullableString(rec, "organizationUuid"),
    organizationName: nullableString(rec, "organizationName"),
    organizationRole: nullableString(rec, "organizationRole"),
    workspaceRole: nullableString(rec, "workspaceRole"),
  };
}

function writeableClaudeAccountInfo(account: AccountData): Record<string, string> {
  const info = account.claude_account ?? null;
  const result: Record<string, string> = {};
  const write = (key: keyof ClaudeAccountInfoData, value: string | null | undefined): void => {
    if (value) result[key] = value;
  };
  write("emailAddress", account.email);
  write("displayName", info?.displayName ?? account.email);
  write("accountUuid", info?.accountUuid);
  write("organizationUuid", info?.organizationUuid);
  write("organizationName", info?.organizationName);
  write("organizationRole", info?.organizationRole);
  write("workspaceRole", info?.workspaceRole);
  return result;
}

export function getStandardClaudeAccountInfo(): ClaudeAccountInfoData | null {
  let raw: string;
  try {
    raw = readFileSync(claudeJsonPath(), "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const oa = (parsed as Record<string, unknown>)["oauthAccount"];
  if (typeof oa !== "object" || oa === null) return null;
  return readClaudeAccountInfo(oa);
}

function updateStandardClaudeAccountInfo(account: AccountData): void {
  if (!account.email) return;
  const path = claudeJsonPath();
  let parsed: Record<string, unknown> = {};
  try {
    const raw = readFileSync(path, "utf-8");
    const value = JSON.parse(raw) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  parsed["oauthAccount"] = writeableClaudeAccountInfo(account);

  try {
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  } catch {
    // Best-effort only. Credential activation is still the source of truth.
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
  return safeSet(account.keychain_service, user, credential.secret);
}

export function activateAccountCredential(account: AccountData): boolean {
  const source = getAccountCredential(account);
  if (source === null) return false;
  const user = source.account || defaultKeychainAccount();
  const current = getStandardClaudeCredential();
  if (current && current.secret === source.secret && current.account === user) {
    updateStandardClaudeAccountInfo(account);
    return true;
  }
  const ok = safeSet(CLAUDE_KEYCHAIN_SERVICE, user, source.secret);
  if (ok) updateStandardClaudeAccountInfo(account);
  return ok;
}

export function deleteAccountCredential(account: AccountData): void {
  if (!account.keychain_service) return;
  safeDelete(account.keychain_service, account.keychain_account || defaultKeychainAccount());
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
