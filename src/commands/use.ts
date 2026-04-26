import { findAccount, loadConfig } from "../core/config.js";
import { buildClaudeLaunchAuth } from "../core/env.js";
import { loadState, saveState } from "../core/state.js";
import { accountNeedsRelogin } from "../core/accounts.js";

export function runUse(name: string): number {
  const config = loadConfig();
  const state = loadState();
  const account = findAccount(config, name);
  if (!account) {
    console.error(`account "${name}" not found`);
    return 1;
  }
  if (accountNeedsRelogin(account)) {
    console.error(`[ccswap] Account '${account.name}' needs re-login. Run: ccswap login ${account.name}`);
    return 1;
  }
  const auth = buildClaudeLaunchAuth(account, config.auth_mode);
  if (auth.error) {
    console.error(auth.error.trimEnd());
    return 1;
  }
  state.last_default_account = state.default_account;
  state.default_account = account.name;
  saveState(state);
  console.log(`default account set to "${account.name}"`);
  return 0;
}
