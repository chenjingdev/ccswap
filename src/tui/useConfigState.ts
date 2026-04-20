import { useCallback, useState } from "react";

import { removeAccount as removeAccountCore } from "../core/accounts.js";
import type { AccountData, AppConfigData } from "../core/config.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { getAccountCredential, parseStoredCredential } from "../core/credentials.js";
import { loadState, saveState, type AppStateData } from "../core/state.js";
import { accountUsageCachePath, loadUsageCache, type UsageSnapshot } from "../core/usage.js";

export interface AccountView {
  account: AccountData;
  loggedIn: boolean;
  subscriptionType: string | null;
  usage: UsageSnapshot;
}

export interface ConfigStateApi {
  config: AppConfigData;
  state: AppStateData;
  accounts: AccountView[];
  reload(): void;
  removeAccount(name: string): string | null;
  setActive(name: string): string | null;
  toggleAutoSwap(name: string): void;
}

export function useConfigState(): ConfigStateApi {
  const [config, setConfig] = useState<AppConfigData>(() => loadConfig());
  const [state, setState] = useState<AppStateData>(() => loadState());

  const buildViews = useCallback((cfg: AppConfigData): AccountView[] => {
    return cfg.accounts.map((account) => {
      const credential = getAccountCredential(account);
      const parsed = parseStoredCredential(credential?.secret ?? null);
      return {
        account,
        loggedIn: credential !== null,
        subscriptionType: parsed.subscription_type,
        usage: loadUsageCache(accountUsageCachePath(account)),
      };
    });
  }, []);

  const [accounts, setAccounts] = useState<AccountView[]>(() => buildViews(config));

  const reload = useCallback((): void => {
    const next = loadConfig();
    setConfig(next);
    setAccounts(buildViews(next));
    setState(loadState());
  }, [buildViews]);

  const removeAccount = useCallback((name: string): string | null => {
    try {
      const current = loadConfig();
      removeAccountCore(current, name);
      const st = loadState();
      if (st.active_account === name) st.active_account = null;
      if (st.last_account === name) st.last_account = null;
      saveState(st);
      setConfig(current);
      setAccounts(buildViews(current));
      setState(st);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, [buildViews]);

  const setActive = useCallback((name: string): string | null => {
    const current = loadConfig();
    const account = current.accounts.find((a) => a.name === name);
    if (!account) return `account "${name}" not found`;
    const st = loadState();
    st.last_account = st.active_account;
    st.active_account = account.name;
    saveState(st);
    setState(st);
    return null;
  }, []);

  const toggleAutoSwap = useCallback((name: string): void => {
    const current = loadConfig();
    const target = current.accounts.find((a) => a.name === name);
    if (!target) return;
    target.auto_swap = !target.auto_swap;
    saveConfig(current);
    setConfig(current);
    setAccounts(buildViews(current));
  }, [buildViews]);

  return {
    config,
    state,
    accounts,
    reload,
    removeAccount,
    setActive,
    toggleAutoSwap,
  };
}
