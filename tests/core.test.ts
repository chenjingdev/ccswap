import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_BASE_URL;
    vi.doUnmock("../src/core/credentials.js");
    vi.doUnmock("../src/claude/pty-interactive.js");
  });

  it("adds and removes accounts and persists to JSON", async () => {
    const configMod = await import("../src/core/config.js");
    const accountsMod = await import("../src/core/accounts.js");

    let cfg = configMod.loadConfig();
    expect(cfg.accounts).toHaveLength(0);
    expect(cfg.replay_mode).toBe("continue");

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
      ["accounts", "auth_mode", "claude_bin", "custom_prompt", "proactive_swap_threshold_pct", "replay_mode"].sort(),
    );
    const account = (raw["accounts"] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(account).sort()).toEqual(
      ["auth_source", "auto_swap", "email", "keychain_account", "keychain_service", "name"].sort(),
    );
    expect(account.auth_source).toBe("credential");
  });

  it("does not load folder-backed or unmarked account rows", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [
        { name: "old", claude_config_dir: "/tmp/old-claude-dir" },
        { name: "unmarked", keychain_service: "ccswap-account:unmarked" },
        {
          name: "work",
          auth_source: "credential",
          auto_swap: false,
          keychain_service: "ccswap-account:work",
          keychain_account: "acct",
        },
      ],
    });

    const configMod = await import("../src/core/config.js");
    const cfg = configMod.loadConfig();
    expect(cfg.accounts.map((a) => a.name)).toEqual(["work"]);
    expect(cfg.accounts[0]?.auto_swap).toBe(false);
    expect(cfg.proactive_swap_threshold_pct).toBe(95);
  });

  it("collapses duplicate email rows without replacing the original credential pointer", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [
        {
          name: "work@example.com",
          auth_source: "credential",
          auto_swap: true,
          keychain_service: "ccswap-account:old",
          keychain_account: "old-acct",
          email: "work@example.com",
        },
        {
          name: "work@example.com-2",
          auth_source: "credential",
          auto_swap: false,
          keychain_service: "ccswap-account:new",
          keychain_account: "new-acct",
          email: "WORK@example.com",
        },
      ],
    });

    const configMod = await import("../src/core/config.js");
    const cfg = configMod.loadConfig();
    expect(cfg.accounts).toHaveLength(1);
    expect(cfg.accounts[0]).toMatchObject({
      name: "work@example.com",
      auto_swap: true,
      keychain_service: "ccswap-account:old",
      keychain_account: "old-acct",
      email: "work@example.com",
    });
  });

  it("defaults legacy configs to keychain-copy auth mode and saves the new field", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [{ name: "legacy", auth_source: "credential" }],
      claude_bin: "claude",
    });

    const configMod = await import("../src/core/config.js");
    const cfg = configMod.loadConfig();
    expect(cfg.auth_mode).toBe("keychain_copy");

    configMod.saveConfig(cfg);
    const raw = JSON.parse(readFileSync(pathsMod.CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    expect(raw.auth_mode).toBe("keychain_copy");
  });

  it("loads supported auth modes and normalizes removed or unknown values to keychain-copy", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    const configMod = await import("../src/core/config.js");

    writeJson(pathsMod.CONFIG_PATH, { accounts: [], auth_mode: "oauth_env" });
    expect(configMod.loadConfig().auth_mode).toBe("oauth_env");

    writeJson(pathsMod.CONFIG_PATH, { accounts: [], auth_mode: "proxy" });
    expect(configMod.loadConfig().auth_mode).toBe("keychain_copy");

    writeJson(pathsMod.CONFIG_PATH, { accounts: [], auth_mode: "experimental" });
    expect(configMod.loadConfig().auth_mode).toBe("keychain_copy");
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

  it("strips Claude auth env by default", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "old-oauth";
    process.env.ANTHROPIC_API_KEY = "old-api-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "old-auth";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example";
    process.env.ANTHROPIC_API_BASE_URL = "https://legacy-proxy.example";

    const { buildClaudeEnv } = await import("../src/core/env.js");
    const env = buildClaudeEnv();

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_BASE_URL).toBeUndefined();
  });

  it("can explicitly inject only the Claude Code OAuth token", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "old-oauth";
    process.env.ANTHROPIC_API_KEY = "old-api-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "old-auth";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example";

    const { buildClaudeEnv } = await import("../src/core/env.js");
    const env = buildClaudeEnv({ oauthToken: "fresh-oauth" });

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-oauth");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("builds keychain-copy launch auth by activating the selected credential", async () => {
    const activateAccountCredential = vi.fn(() => true);
    const getAccountCredential = vi.fn();
    vi.doMock("../src/core/credentials.js", () => ({
      activateAccountCredential,
      getAccountCredential,
      parseStoredCredential: vi.fn(),
    }));

    const { buildClaudeLaunchAuth } = await import("../src/core/env.js");
    const result = buildClaudeLaunchAuth({
      name: "work",
      auth_source: "credential",
      auto_swap: true,
      keychain_service: "svc",
      keychain_account: "acct",
      email: null,
    }, "keychain_copy");

    expect(result.error).toBeNull();
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(activateAccountCredential).toHaveBeenCalledOnce();
    expect(getAccountCredential).not.toHaveBeenCalled();
  });

  it("builds oauth-env launch auth from the selected credential without activation", async () => {
    const activateAccountCredential = vi.fn();
    const getAccountCredential = vi.fn(() => ({ service: "svc", account: "acct", secret: "secret" }));
    const parseStoredCredential = vi.fn(() => ({ access_token: "selected-token", subscription_type: "max" }));
    vi.doMock("../src/core/credentials.js", () => ({
      activateAccountCredential,
      getAccountCredential,
      parseStoredCredential,
    }));

    const { buildClaudeLaunchAuth } = await import("../src/core/env.js");
    const result = buildClaudeLaunchAuth({
      name: "work",
      auth_source: "credential",
      auto_swap: true,
      keychain_service: "svc",
      keychain_account: "acct",
      email: null,
    }, "oauth_env");

    expect(result.error).toBeNull();
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("selected-token");
    expect(getAccountCredential).toHaveBeenCalledOnce();
    expect(parseStoredCredential).toHaveBeenCalledWith("secret");
    expect(activateAccountCredential).not.toHaveBeenCalled();
  });

  it("use command honors oauth-env without activating the standard credential", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    const activateAccountCredential = vi.fn();
    const getAccountCredential = vi.fn(() => ({ service: "svc", account: "acct", secret: "secret" }));
    const parseStoredCredential = vi.fn(() => ({ access_token: "selected-token", subscription_type: "max" }));
    vi.doMock("../src/core/credentials.js", () => ({
      activateAccountCredential,
      getAccountCredential,
      parseStoredCredential,
    }));
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [{
        name: "work",
        auth_source: "credential",
        auto_swap: true,
        keychain_service: "svc",
        keychain_account: "acct",
        email: null,
      }],
      auth_mode: "oauth_env",
    });
    writeJson(pathsMod.STATE_PATH, { default_account: null, last_default_account: null });

    const { runUse } = await import("../src/commands/use.js");
    expect(runUse("work")).toBe(0);

    const state = JSON.parse(readFileSync(pathsMod.STATE_PATH, "utf-8")) as {
      default_account: string | null;
      last_default_account: string | null;
    };
    expect(state.default_account).toBe("work");
    expect(getAccountCredential).toHaveBeenCalledOnce();
    expect(parseStoredCredential).toHaveBeenCalledWith("secret");
    expect(activateAccountCredential).not.toHaveBeenCalled();
  });

  it("sets the first successful login as default when no default exists", async () => {
    const pathsMod = await import("../src/core/paths.js");
    vi.doMock("../src/claude/pty-interactive.js", () => ({
      runInteractive: vi.fn(async () => ({ exitCode: 0 })),
    }));
    vi.doMock("../src/core/credentials.js", () => ({
      getStandardClaudeAccountInfo: vi.fn(() => ({ emailAddress: "work@example.com" })),
      getStandardClaudeCredential: vi.fn(() => ({
        service: "Claude Code-credentials",
        account: "Claude Code",
        secret: "secret",
      })),
      invalidateStandardClaudeCredentialCache: vi.fn(),
      storeAccountCredential: vi.fn(() => true),
    }));

    const { runLoginNewAccount } = await import("../src/commands/login.js");
    await expect(runLoginNewAccount()).resolves.toEqual({
      exitCode: 0,
      accountName: "work@example.com",
    });

    const state = JSON.parse(readFileSync(pathsMod.STATE_PATH, "utf-8")) as {
      default_account: string | null;
      last_default_account: string | null;
    };
    expect(state.default_account).toBe("work@example.com");
    expect(state.last_default_account).toBe("work@example.com");
  });

  it("reuses an existing account when a new login reports the same email", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    const storeAccountCredential = vi.fn(() => true);
    vi.doMock("../src/claude/pty-interactive.js", () => ({
      runInteractive: vi.fn(async () => ({ exitCode: 0 })),
    }));
    vi.doMock("../src/core/credentials.js", () => ({
      getStandardClaudeAccountInfo: vi.fn(() => ({ emailAddress: "work@example.com" })),
      getStandardClaudeCredential: vi.fn(() => ({
        service: "Claude Code-credentials",
        account: "Claude Code",
        secret: "secret",
      })),
      invalidateStandardClaudeCredentialCache: vi.fn(),
      storeAccountCredential,
    }));
    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [
        {
          name: "work@example.com",
          auth_source: "credential",
          auto_swap: true,
          keychain_service: "ccswap-account:work-example.com",
          keychain_account: "acct",
          email: "work@example.com",
        },
      ],
    });

    const { runLoginNewAccount } = await import("../src/commands/login.js");
    await expect(runLoginNewAccount()).resolves.toEqual({
      exitCode: 0,
      accountName: "work@example.com",
    });

    const cfg = JSON.parse(readFileSync(pathsMod.CONFIG_PATH, "utf-8")) as {
      accounts: Array<{ name: string; email: string | null }>;
    };
    expect(cfg.accounts.map((account) => account.name)).toEqual(["work@example.com"]);
    expect(storeAccountCredential).toHaveBeenCalledOnce();
  });

  it("promotes the next logged-in account when removing the default account", async () => {
    const pathsMod = await import("../src/core/paths.js");
    const { writeJson } = await import("../src/core/fs-util.js");
    const deleteAccountCredential = vi.fn();
    vi.doMock("../src/core/credentials.js", () => ({
      deleteAccountCredential,
      getAccountCredential: vi.fn((account) =>
        account.name === "side" ? { service: "svc", account: "acct", secret: "secret" } : null,
      ),
      parseStoredCredential: vi.fn(() => ({ access_token: "token", subscription_type: "max" })),
    }));

    writeJson(pathsMod.CONFIG_PATH, {
      accounts: [
        {
          name: "work",
          auth_source: "credential",
          auto_swap: true,
          keychain_service: "ccswap-account:work",
          keychain_account: "acct",
          email: null,
        },
        {
          name: "side",
          auth_source: "credential",
          auto_swap: true,
          keychain_service: "ccswap-account:side",
          keychain_account: "acct",
          email: null,
        },
      ],
    });
    writeJson(pathsMod.STATE_PATH, { default_account: "work", last_default_account: "work" });

    const { runAccountRemove } = await import("../src/commands/account.js");
    expect(runAccountRemove("work")).toBe(0);

    const state = JSON.parse(readFileSync(pathsMod.STATE_PATH, "utf-8")) as {
      default_account: string | null;
      last_default_account: string | null;
    };
    expect(state.default_account).toBe("side");
    expect(state.last_default_account).toBe("side");
    expect(deleteAccountCredential).toHaveBeenCalledOnce();
  });

});
