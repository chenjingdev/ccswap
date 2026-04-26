import { readJson, writeJson } from "./fs-util.js";
import { STATE_PATH } from "./paths.js";

export interface AppStateData {
  default_account: string | null;
  last_default_account: string | null;
}

interface StateFile {
  default_account?: string | null;
  last_default_account?: string | null;
  active_account?: string | null;
  last_account?: string | null;
}

export function loadState(): AppStateData {
  const raw = readJson<StateFile>(STATE_PATH, {});
  return {
    default_account: raw.default_account ?? raw.active_account ?? null,
    last_default_account: raw.last_default_account ?? raw.last_account ?? null,
  };
}

export function saveState(state: AppStateData): void {
  writeJson(STATE_PATH, state);
}
