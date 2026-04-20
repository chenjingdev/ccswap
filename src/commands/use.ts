import { findAccount, loadConfig } from "../core/config.js";
import { activateAccountCredential } from "../core/credentials.js";
import { loadState, saveState } from "../core/state.js";

export function runUse(name: string): number {
  const config = loadConfig();
  const state = loadState();
  const account = findAccount(config, name);
  if (!account) {
    console.error(`account "${name}" not found`);
    return 1;
  }
  const activated = activateAccountCredential(account);
  if (!activated) {
    console.error(`account "${name}" has no saved login. run: ccswap login ${name}`);
    return 1;
  }
  state.last_account = state.active_account;
  state.active_account = account.name;
  saveState(state);
  console.log(`switched to "${account.name}"`);
  return 0;
}
