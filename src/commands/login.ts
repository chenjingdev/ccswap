import { findAccount, loadConfig, saveConfig } from "../core/config.js";
import { getStandardClaudeCredential, storeAccountCredential } from "../core/credentials.js";
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

  const credential = getStandardClaudeCredential();
  if (!credential || !storeAccountCredential(account, credential)) {
    console.error("login succeeded but no Claude credentials were captured");
    return 1;
  }
  saveConfig(config);
  console.log(`saved login for "${account.name}"`);
  return 0;
}
