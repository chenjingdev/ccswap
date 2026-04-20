import { addAccount, getAccountStatus, removeAccount } from "../core/accounts.js";
import { loadConfig } from "../core/config.js";
import { loadState, saveState } from "../core/state.js";

export function runAccountAdd(name: string): number {
  const config = loadConfig();
  try {
    const account = addAccount(config, name);
    console.log(`added account "${account.name}"`);
    return 0;
  } catch (err) {
    console.error(`${(err as Error).message}`);
    return 1;
  }
}

export function runAccountList(): number {
  const config = loadConfig();
  const state = loadState();
  if (config.accounts.length === 0) {
    console.log("no accounts configured. run: ccswap account add <name>");
    return 0;
  }
  for (const account of config.accounts) {
    const marker = state.active_account === account.name ? "*" : " ";
    const status = getAccountStatus(account);
    const login = status.logged_in ? "logged in" : "no login";
    const swap = account.auto_swap ? "auto-swap" : "manual";
    console.log(`${marker} ${account.name.padEnd(20)} ${login.padEnd(12)} ${swap}`);
  }
  return 0;
}

export function runAccountRemove(name: string): number {
  const config = loadConfig();
  const state = loadState();
  try {
    removeAccount(config, name);
    if (state.active_account === name) state.active_account = null;
    if (state.last_account === name) state.last_account = null;
    saveState(state);
    console.log(`removed account "${name}"`);
    return 0;
  } catch (err) {
    console.error(`${(err as Error).message}`);
    return 1;
  }
}
