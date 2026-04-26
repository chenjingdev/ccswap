import type { AppConfigData } from "./config.js";
import { getAccountCredential } from "./credentials.js";
import type { AppStateData } from "./state.js";

export function resolveStoredDefaultAccount(
  config: AppConfigData,
  state: AppStateData,
): string | null {
  const loggedIn = config.accounts.filter((account) => getAccountCredential(account) !== null);
  if (state.default_account && loggedIn.some((account) => account.name === state.default_account)) {
    return state.default_account;
  }
  if (state.last_default_account && loggedIn.some((account) => account.name === state.last_default_account)) {
    return state.last_default_account;
  }
  return loggedIn[0]?.name ?? null;
}

export function promoteDefaultAfterAccountRemoval(
  config: AppConfigData,
  state: AppStateData,
  removedName: string,
): AppStateData {
  const next: AppStateData = { ...state };
  if (next.default_account === removedName) next.default_account = null;
  if (next.last_default_account === removedName) next.last_default_account = null;
  if (!next.default_account) {
    const replacement = resolveStoredDefaultAccount(config, next);
    next.default_account = replacement;
    if (replacement) next.last_default_account = replacement;
  }
  return next;
}
