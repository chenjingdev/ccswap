import { useCallback, useState } from "react";

import { accountNeedsRelogin, removeAccount as removeAccountCore } from "../core/accounts.js";
import { promoteDefaultAfterAccountRemoval } from "../core/default-account.js";
import type { AccountData, AppConfigData } from "../core/config.js";
import { loadConfig, saveConfig } from "../core/config.js";
import { getAccountCredential, parseStoredCredential } from "../core/credentials.js";
import { loadState, saveState, type AppStateData } from "../core/state.js";
import { accountUsageCachePath, loadUsageCache, usagePlanName, type UsageSnapshot } from "../core/usage.js";

export interface AccountView {
  account: AccountData;
  loggedIn: boolean;
  needsRelogin: boolean;
  subscriptionType: string | null;
  usage: UsageSnapshot;
}

export interface ConfigStateApi {
  config: AppConfigData;
  state: AppStateData;
  accounts: AccountView[];
  reload(): void;
  removeAccount(name: string): string | null;
  setDefault(name: string): string | null;
  toggleAutoSwap(name: string): void;
}

export function useConfigState(): ConfigStateApi {
  const [config, setConfig] = useState<AppConfigData>(() => loadConfig());
  const [state, setState] = useState<AppStateData>(() => loadState());

  const buildViews = useCallback((cfg: AppConfigData): AccountView[] => {
    return cfg.accounts.map((account) => {
      const credential = getAccountCredential(account);
      const parsed = parseStoredCredential(credential?.secret ?? null);
      const usage = loadUsageCache(accountUsageCachePath(account), {
        accessToken: parsed.access_token,
        subscriptionType: parsed.subscription_type,
      });
      return {
        account,
        loggedIn: credential !== null,
        needsRelogin: accountNeedsRelogin(account),
        subscriptionType: usage.plan_name ?? usagePlanName(parsed.subscription_type) ?? parsed.subscription_type,
        usage,
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
      const st = promoteDefaultAfterAccountRemoval(current, loadState(), name);
      saveState(st);
      setConfig(current);
      setAccounts(buildViews(current));
      setState(st);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, [buildViews]);

  const setDefault = useCallback((name: string): string | null => {
    const current = loadConfig();
    const account = current.accounts.find((a) => a.name === name);
    if (!account) return `account "${name}" not found`;
    const st = loadState();
    st.last_default_account = st.default_account;
    st.default_account = account.name;
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
    setDefault,
    toggleAutoSwap,
  };
}
