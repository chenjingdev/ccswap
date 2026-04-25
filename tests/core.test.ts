import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("paths", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-test-"));
    vi.resetModules();
    process.env.CCSWAP_CONFIG_DIR = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.CCSWAP_CONFIG_DIR;
  });

  it("sanitizes account names for keychain service", async () => {
    const mod = await import("../src/core/paths.js");
    expect(mod.sanitizeAccountName("hello world!")).toBe("hello-world");
    expect(mod.sanitizeAccountName("---")).toBe("account");
    expect(mod.defaultKeychainService("my acc/1")).toBe("ccswap-account:my-acc-1");
  });

  it("resolves config paths under CCSWAP_CONFIG_DIR", async () => {
    const mod = await import("../src/core/paths.js");
    expect(mod.CONFIG_DIR).toBe(tempRoot);
    expect(mod.CONFIG_PATH).toBe(join(tempRoot, "config.json"));
  });
});

describe("config + accounts", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-test-"));
    vi.resetModules();
    process.env.CCSWAP_CONFIG_DIR = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.CCSWAP_CONFIG_DIR;
  });

  it("adds and removes accounts and persists to JSON", async () => {
    const configMod = await import("../src/core/config.js");
    const accountsMod = await import("../src/core/accounts.js");

    let cfg = configMod.loadConfig();
    expect(cfg.accounts).toHaveLength(0);

    accountsMod.addAccount(cfg, "work");
    accountsMod.addAccount(cfg, "side");

    cfg = configMod.loadConfig();
    expect(cfg.accounts.map((a) => a.name)).toEqual(["work", "side"]);
    expect(cfg.accounts[0]?.keychain_service).toBe("ccswap-account:work");
    expect(cfg.accounts[0]?.auto_swap).toBe(true);

    accountsMod.removeAccount(cfg, "side");
    cfg = configMod.loadConfig();
    expect(cfg.accounts.map((a) => a.name)).toEqual(["work"]);
  });

  it("rejects duplicate account names", async () => {
    const configMod = await import("../src/core/config.js");
    const accountsMod = await import("../src/core/accounts.js");

    const cfg = configMod.loadConfig();
    accountsMod.addAccount(cfg, "work");
    expect(() => accountsMod.addAccount(cfg, "work")).toThrow(/already exists/);
  });

  it("preserves Python-compatible config.json field names", async () => {
    const configMod = await import("../src/core/config.js");
    const accountsMod = await import("../src/core/accounts.js");
    const pathsMod = await import("../src/core/paths.js");

    const cfg = configMod.loadConfig();
    accountsMod.addAccount(cfg, "work");

    const raw = JSON.parse(readFileSync(pathsMod.CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(
      ["accounts", "claude_bin", "custom_prompt", "proactive_swap_threshold_pct", "replay_mode"].sort(),
    );
    const account = (raw["accounts"] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(account).sort()).toEqual(
      ["auto_swap", "email", "keychain_account", "keychain_service", "name"].sort(),
    );
  });

  it("reads legacy enabled field as auto_swap", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [{ name: "legacy", enabled: false }],
      claude_bin: "claude",
      replay_mode: "last_prompt",
      custom_prompt: "",
    });

    const configMod = await import("../src/core/config.js");
    const cfg = configMod.loadConfig();
    expect(cfg.accounts[0]?.auto_swap).toBe(false);
    expect(cfg.proactive_swap_threshold_pct).toBe(95);
  });

  it("ignores legacy claude_config_dir fields instead of re-saving account folders", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [{ name: "legacy", claude_config_dir: "/tmp/old-claude-dir" }],
    });

    const configMod = await import("../src/core/config.js");
    const cfg = configMod.loadConfig();
    expect("claude_config_dir" in cfg.accounts[0]!).toBe(false);
    configMod.saveConfig(cfg);
    const raw = JSON.parse(readFileSync(pathsMod.CONFIG_PATH, "utf-8")) as {
      accounts: Array<Record<string, unknown>>;
    };
    expect(raw.accounts[0]).not.toHaveProperty("claude_config_dir");
  });

  it("parses stored Claude credentials JSON shape", async () => {
    const { parseStoredCredential } = await import("../src/core/credentials.js");
    const payload = JSON.stringify({
      claudeAiOauth: {
        accessToken: "tok-xyz",
        subscriptionType: "max",
      },
    });
    expect(parseStoredCredential(payload)).toEqual({
      access_token: "tok-xyz",
      subscription_type: "max",
    });
    expect(parseStoredCredential(null)).toEqual({ access_token: null, subscription_type: null });
    expect(parseStoredCredential("not-json")).toEqual({ access_token: null, subscription_type: null });
  });
});
