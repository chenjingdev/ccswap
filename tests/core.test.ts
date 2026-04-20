import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("paths", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-test-"));
    vi.resetModules();
    process.env.XDG_CONFIG_HOME = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it("sanitizes account names for directory and keychain service", async () => {
    const mod = await import("../src/core/paths.js");
    expect(mod.sanitizeAccountName("hello world!")).toBe("hello-world");
    expect(mod.sanitizeAccountName("---")).toBe("account");
    expect(mod.defaultKeychainService("my acc/1")).toBe("ccswap-account:my-acc-1");
    expect(mod.defaultAccountDir("my acc/1").endsWith("/accounts/my-acc-1/claude")).toBe(true);
  });

  it("resolves config paths under XDG_CONFIG_HOME", async () => {
    const mod = await import("../src/core/paths.js");
    expect(mod.CONFIG_DIR).toBe(join(tempRoot, "ccswap"));
    expect(mod.CONFIG_PATH).toBe(join(tempRoot, "ccswap", "config.json"));
  });
});

describe("config + accounts", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-test-"));
    vi.resetModules();
    process.env.XDG_CONFIG_HOME = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  it("adds, renames, removes accounts and persists to JSON", async () => {
    const configMod = await import("../src/core/config.js");
    const accountsMod = await import("../src/core/accounts.js");
    const pathsMod = await import("../src/core/paths.js");

    let cfg = configMod.loadConfig();
    expect(cfg.accounts).toHaveLength(0);

    accountsMod.addAccount(cfg, "work");
    accountsMod.addAccount(cfg, "side");

    cfg = configMod.loadConfig();
    expect(cfg.accounts.map((a) => a.name)).toEqual(["work", "side"]);
    expect(cfg.accounts[0]?.keychain_service).toBe("ccswap-account:work");
    expect(cfg.accounts[0]?.auto_swap).toBe(true);

    accountsMod.renameAccount(cfg, "side", "personal");
    cfg = configMod.loadConfig();
    const renamed = configMod.findAccount(cfg, "personal");
    expect(renamed).toBeDefined();
    expect(renamed?.keychain_service).toBe("ccswap-account:personal");
    expect(renamed?.claude_config_dir).toBe(pathsMod.defaultAccountDir("personal"));

    accountsMod.removeAccount(cfg, "personal");
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
      ["accounts", "claude_bin", "custom_prompt", "replay_mode"].sort(),
    );
    const account = (raw["accounts"] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(account).sort()).toEqual(
      ["auto_swap", "claude_config_dir", "keychain_account", "keychain_service", "name"].sort(),
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
