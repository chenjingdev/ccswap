import { loadConfig, saveConfig } from "../core/config.js";
import { ensureDir } from "../core/fs-util.js";
import { CONFIG_DIR } from "../core/paths.js";
import { loadState, saveState } from "../core/state.js";

export function runInit(): number {
  ensureDir(CONFIG_DIR);
  const config = loadConfig();
  const state = loadState();
  saveConfig(config);
  saveState(state);
  console.log(`ccswap initialized at ${CONFIG_DIR}`);
  return 0;
}
