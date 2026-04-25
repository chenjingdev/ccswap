import { homedir, platform } from "node:os";
import { join } from "node:path";

const APP_NAME = "ccswap";

function configRoot(): string {
  const override = process.env.CCSWAP_CONFIG_DIR;
  if (override) return override;
  if (platform() === "win32") {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, APP_NAME);
    return join(homedir(), "AppData", "Roaming", APP_NAME);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, APP_NAME);
  return join(homedir(), ".config", APP_NAME);
}

export const CONFIG_DIR = configRoot();
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STATE_PATH = join(CONFIG_DIR, "state.json");
export const LOG_PATH = join(CONFIG_DIR, "ccswap.log");
export const RUNTIME_DIR = join(CONFIG_DIR, "runtime");
export const USAGE_CACHE_DIR = join(CONFIG_DIR, "usage-cache");

export function sanitizeAccountName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "account";
}

export function defaultKeychainService(name: string): string {
  return `ccswap-account:${sanitizeAccountName(name)}`;
}

export function defaultKeychainAccount(): string {
  return process.env.USER ?? process.env.USERNAME ?? "ccswap";
}
