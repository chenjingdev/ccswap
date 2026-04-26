import {
  addAccount,
  clearAccountAuthError,
  deriveUniqueAccountName,
  findAccountByEmail,
} from "../core/accounts.js";
import { findAccount, loadConfig, saveConfig } from "../core/config.js";
import {
  getStandardClaudeAccountInfo,
  getStandardClaudeCredential,
  invalidateStandardClaudeCredentialCache,
  storeAccountCredential,
} from "../core/credentials.js";
import { buildClaudeEnv } from "../core/env.js";
import { loadState, saveState } from "../core/state.js";
import { runInteractive } from "../claude/pty-interactive.js";

function setInitialActiveAccount(accountName: string): void {
  const state = loadState();
  if (state.active_account || state.last_account) return;
  state.active_account = accountName;
  state.last_account = accountName;
  saveState(state);
}

export async function runLogin(name: string): Promise<number> {
  const config = loadConfig();
  const account = findAccount(config, name);
  if (!account) {
    console.error(`account "${name}" not found`);
    return 1;
  }

  const result = await runInteractive({
    cmd: config.claude_bin,
    args: ["auth", "login", "--claudeai"],
    cwd: process.cwd(),
    env: buildClaudeEnv(),
    title: `Login: ${account.name}`,
  });

  if (result.exitCode !== 0) {
    console.error(`login cancelled or failed for "${account.name}"`);
    return result.exitCode || 1;
  }

  invalidateStandardClaudeCredentialCache();
  const credential = getStandardClaudeCredential();
  if (!credential || !storeAccountCredential(account, credential)) {
    console.error("login succeeded but no Claude credentials were captured");
    return 1;
  }
  const info = getStandardClaudeAccountInfo();
  if (info) {
    account.claude_account = info;
    if (info.emailAddress) account.email = info.emailAddress;
  }
  clearAccountAuthError(account);
  saveConfig(config);
  setInitialActiveAccount(account.name);
  console.log(`saved login for "${account.name}"`);
  return 0;
}

export async function runLoginNewAccount(): Promise<{ exitCode: number; accountName: string | null }> {
  const config = loadConfig();

  const result = await runInteractive({
    cmd: config.claude_bin,
    args: ["auth", "login", "--claudeai"],
    cwd: process.cwd(),
    env: buildClaudeEnv(),
    title: "Login: new Claude account",
  });

  if (result.exitCode !== 0) {
    console.error("login cancelled or failed");
    return { exitCode: result.exitCode || 1, accountName: null };
  }

  invalidateStandardClaudeCredentialCache();
  const credential = getStandardClaudeCredential();
  if (!credential) {
    console.error("login succeeded but no Claude credentials were captured");
    return { exitCode: 1, accountName: null };
  }

  const info = getStandardClaudeAccountInfo();
  const hint = info?.emailAddress || info?.displayName || null;
  const existing = findAccountByEmail(config, info?.emailAddress ?? null);
  const name = existing?.name ?? deriveUniqueAccountName(config, hint);

  const account = existing ?? addAccount(config, name);
  if (!storeAccountCredential(account, credential)) {
    console.error("login succeeded but failed to save credential");
    return { exitCode: 1, accountName: null };
  }
  if (info) {
    account.claude_account = info;
    if (info.emailAddress) account.email = info.emailAddress;
  }
  clearAccountAuthError(account);
  saveConfig(config);
  setInitialActiveAccount(account.name);
  console.log(`saved login as "${name}"`);
  return { exitCode: 0, accountName: name };
}
