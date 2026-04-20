import { readJson, writeJson } from "./fs-util.js";
import { STATE_PATH } from "./paths.js";

export interface AppStateData {
  active_account: string | null;
  last_account: string | null;
}

interface StateFile {
  active_account?: string | null;
  last_account?: string | null;
}

export function loadState(): AppStateData {
  const raw = readJson<StateFile>(STATE_PATH, {});
  return {
    active_account: raw.active_account ?? null,
    last_account: raw.last_account ?? null,
  };
}

export function saveState(state: AppStateData): void {
  writeJson(STATE_PATH, state);
}
