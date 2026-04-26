import type { AppConfigData } from "./config.js";
import { getAccountCredential } from "./credentials.js";
import type { AppStateData } from "./state.js";

export function resolveStoredActiveAccount(
  config: AppConfigData,
  state: AppStateData,
): string | null {
  const loggedIn = config.accounts.filter((account) => getAccountCredential(account) !== null);
  if (state.active_account && loggedIn.some((account) => account.name === state.active_account)) {
    return state.active_account;
  }
  if (state.last_account && loggedIn.some((account) => account.name === state.last_account)) {
    return state.last_account;
  }
  return loggedIn[0]?.name ?? null;
}

export function promoteActiveAfterAccountRemoval(
  config: AppConfigData,
  state: AppStateData,
  removedName: string,
): AppStateData {
  const next: AppStateData = { ...state };
  if (next.active_account === removedName) next.active_account = null;
  if (next.last_account === removedName) next.last_account = null;
  if (!next.active_account) {
    const replacement = resolveStoredActiveAccount(config, next);
    next.active_account = replacement;
    if (replacement) next.last_account = replacement;
  }
  return next;
}
