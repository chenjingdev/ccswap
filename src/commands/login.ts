import { addAccount, deriveUniqueAccountName } from "../core/accounts.js";
import { findAccount, loadConfig, saveConfig } from "../core/config.js";
import {
  getStandardClaudeAccountInfo,
  getStandardClaudeCredential,
  invalidateStandardClaudeCredentialCache,
  storeAccountCredential,
} from "../core/credentials.js";
import { buildClaudeEnv } from "../core/env.js";
import { runInteractive } from "../claude/pty-interactive.js";

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
  if (info?.emailAddress) account.email = info.emailAddress;
  saveConfig(config);
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
  const name = deriveUniqueAccountName(config, hint);

  const account = addAccount(config, name);
  if (!storeAccountCredential(account, credential)) {
    console.error("login succeeded but failed to save credential");
    return { exitCode: 1, accountName: null };
  }
  if (info?.emailAddress) account.email = info.emailAddress;
  saveConfig(config);
  console.log(`saved login as "${name}"`);
  return { exitCode: 0, accountName: name };
}
