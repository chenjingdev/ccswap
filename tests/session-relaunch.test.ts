import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTINUE_PROMPT } from "../src/core/constants.js";

const PROMPT = "SESSION_RELAUNCH_PROMPT";

interface LoggedLaunch {
  count: number;
  mode: string;
  argv: string[];
  sessionId: string | null;
}

function readLaunches(logPath: string): LoggedLaunch[] {
  return readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedLaunch);
}

function createFakeClaude(tempRoot: string): string {
  const scriptPath = join(tempRoot, "fake-claude.js");
  const binPath = join(tempRoot, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude");
  writeFileSync(scriptPath, `
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const logPath = process.env.FAKE_CLAUDE_LOG;
const counterPath = process.env.FAKE_CLAUDE_COUNTER;
const mode = process.env.FAKE_CLAUDE_MODE || "proactive";
const prompt = process.env.FAKE_CLAUDE_PROMPT || "prompt";

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] || null : null;
}

function encodeProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

const argv = process.argv.slice(2);
const requestedSessionId = argValue("--session-id") || argValue("--resume");
const shouldCreateSyntheticTranscript =
  process.env.FAKE_CLAUDE_CREATE_EMPTY_TRANSCRIPT === "1" ||
  Boolean(process.env.FAKE_CLAUDE_PROMPT_TRANSCRIPT_DELAY_MS);
const sessionId = requestedSessionId || (shouldCreateSyntheticTranscript ? randomUUID() : null);
const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) + 1 : 1;
fs.writeFileSync(counterPath, String(count));
fs.appendFileSync(logPath, JSON.stringify({ count, mode, argv, sessionId }) + "\\n");

if (count === 1 && process.env.FAKE_CLAUDE_RUNTIME_REPLAY) {
  const runtimeDir = path.join(process.env.CCSWAP_CONFIG_DIR, "runtime");
  for (const name of fs.readdirSync(runtimeDir)) {
    if (!name.endsWith(".json") || name.endsWith(".settings.json")) continue;
    const statePath = path.join(runtimeDir, name);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.replay_mode = process.env.FAKE_CLAUDE_RUNTIME_REPLAY;
    state.custom_prompt = process.env.FAKE_CLAUDE_RUNTIME_PROMPT || null;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
  }
}

function requestAccount(accountName) {
  const runtimeDir = path.join(process.env.CCSWAP_CONFIG_DIR, "runtime");
  for (const name of fs.readdirSync(runtimeDir)) {
    if (!name.endsWith(".json") || name.endsWith(".settings.json")) continue;
    const statePath = path.join(runtimeDir, name);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.requested_account = accountName;
    state.requested_reason = "manual_session_switch";
    state.requested_at = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
  }
}

if (count === 1 && process.env.FAKE_CLAUDE_REQUEST_ACCOUNT) {
  const delay = Number(process.env.FAKE_CLAUDE_REQUEST_DELAY_MS || "0");
  if (delay > 0) {
    setTimeout(() => requestAccount(process.env.FAKE_CLAUDE_REQUEST_ACCOUNT), delay);
  } else {
    requestAccount(process.env.FAKE_CLAUDE_REQUEST_ACCOUNT);
  }
}

if (count === 1 && process.env.FAKE_CLAUDE_DYNAMIC_REQUEST_ACCOUNT) {
  const requested = process.env.FAKE_CLAUDE_DYNAMIC_REQUEST_ACCOUNT;
  const configPath = path.join(process.env.CCSWAP_CONFIG_DIR, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    accounts: [
      { name: "primary", auth_source: "credential", auto_swap: true },
      { name: requested, auth_source: "credential", auto_swap: true },
    ],
    replay_mode: "continue",
    custom_prompt: "",
    proactive_swap_threshold_pct: null,
    auth_mode: "keychain_copy",
  }, null, 2) + "\\n");
  const runtimeDir = path.join(process.env.CCSWAP_CONFIG_DIR, "runtime");
  for (const name of fs.readdirSync(runtimeDir)) {
    if (!name.endsWith(".json") || name.endsWith(".settings.json")) continue;
    const statePath = path.join(runtimeDir, name);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.requested_account = requested;
    state.requested_reason = "manual_session_switch";
    state.requested_at = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
  }
}

if (sessionId) {
  const projectDir = path.join(process.env.HOME, ".claude", "projects", encodeProjectDir(process.cwd()));
  fs.mkdirSync(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, sessionId + ".jsonl");
  const now = new Date().toISOString();
  fs.writeFileSync(transcriptPath, JSON.stringify({ cwd: process.cwd() }) + "\\n");
  const writePrompt = () => {
    fs.appendFileSync(transcriptPath, JSON.stringify({
      type: "user",
      isSidechain: false,
      message: { role: "user", content: prompt },
      timestamp: new Date().toISOString(),
    }) + "\\n");
  };
  const promptDelay = Number(process.env.FAKE_CLAUDE_PROMPT_TRANSCRIPT_DELAY_MS || "0");
  const skipEmptyTranscript =
    process.env.FAKE_CLAUDE_SKIP_EMPTY_TRANSCRIPT === "1" && !argv.includes(prompt);
  if (promptDelay > 0) {
    setTimeout(writePrompt, promptDelay);
  } else if (!skipEmptyTranscript && (requestedSessionId || argv.includes(prompt))) {
    writePrompt();
  }
}

function stop() {
  setTimeout(() => process.exit(0), 10);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (count >= 2) {
  console.log("second launch");
  setTimeout(() => process.exit(0), 100);
} else if (mode === "hard-limit") {
  console.log("API error: Rate limit reached.");
  setInterval(() => {}, 1000);
} else if (mode === "busy") {
  let i = 0;
  const iv = setInterval(() => { console.log("busy", i++); }, 100);
  setTimeout(() => clearInterval(iv), 2600);
  setInterval(() => {}, 1000);
} else if (mode === "silent") {
  setInterval(() => {}, 1000);
} else if (mode === "auth-failure") {
  console.error("Error: 401 Unauthorized");
  setTimeout(() => process.exit(1), 50);
} else {
  console.log("first launch idle");
  setInterval(() => {}, 1000);
}
`, { mode: 0o600 });

  if (process.platform === "win32") {
    writeFileSync(binPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, { mode: 0o600 });
  } else {
    writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o700 });
    chmodSync(binPath, 0o700);
  }
  return binPath;
}

describe("runClaudeSession relaunch arguments", () => {
  let tempRoot: string;
  let oldConfigDir: string | undefined;
  let oldHome: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-session-relaunch-"));
    oldConfigDir = process.env.CCSWAP_CONFIG_DIR;
    oldHome = process.env.HOME;
    process.env.CCSWAP_CONFIG_DIR = join(tempRoot, "config");
    process.env.HOME = join(tempRoot, "home");
    mkdirSync(process.env.CCSWAP_CONFIG_DIR, { recursive: true });
    mkdirSync(process.env.HOME, { recursive: true });
    vi.resetModules();
    vi.doMock("../src/core/credentials.js", () => ({
      getAccountCredential: vi.fn((account: { name: string }) => ({
        service: `svc-${account.name}`,
        account: "acct",
        secret: JSON.stringify({ claudeAiOauth: { accessToken: `token-${account.name}` } }),
      })),
      parseStoredCredential: vi.fn((secret: string) => {
        const parsed = JSON.parse(secret) as { claudeAiOauth?: { accessToken?: string } };
        return {
          access_token: parsed.claudeAiOauth?.accessToken ?? null,
          subscription_type: null,
        };
      }),
      activateAccountCredential: vi.fn(() => true),
    }));
  });

  afterEach(() => {
    vi.doUnmock("../src/core/credentials.js");
    vi.doUnmock("../src/core/usage.js");
    vi.resetModules();
    if (oldConfigDir === undefined) {
      delete process.env.CCSWAP_CONFIG_DIR;
    } else {
      process.env.CCSWAP_CONFIG_DIR = oldConfigDir;
    }
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    delete process.env.FAKE_CLAUDE_LOG;
    delete process.env.FAKE_CLAUDE_COUNTER;
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CLAUDE_PROMPT;
    delete process.env.FAKE_CLAUDE_RUNTIME_REPLAY;
    delete process.env.FAKE_CLAUDE_RUNTIME_PROMPT;
    delete process.env.FAKE_CLAUDE_REQUEST_ACCOUNT;
    delete process.env.FAKE_CLAUDE_REQUEST_DELAY_MS;
    delete process.env.FAKE_CLAUDE_DYNAMIC_REQUEST_ACCOUNT;
    delete process.env.FAKE_CLAUDE_SKIP_EMPTY_TRANSCRIPT;
    delete process.env.FAKE_CLAUDE_CREATE_EMPTY_TRANSCRIPT;
    delete process.env.FAKE_CLAUDE_PROMPT_TRANSCRIPT_DELAY_MS;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function baseConfig(
    claudeBin: string,
    proactiveThresholdPct: number | null,
    replayMode: "last_prompt" | "continue" | "custom_prompt" = "last_prompt",
  ) {
    return {
      accounts: [
        {
          name: "primary",
          auth_source: "credential",
          auto_swap: true,
          keychain_service: "svc-primary",
          keychain_account: "acct",
          email: null,
        },
        {
          name: "backup",
          auth_source: "credential",
          auto_swap: true,
          keychain_service: "svc-backup",
          keychain_account: "acct",
          email: null,
        },
      ],
      claude_bin: claudeBin,
      replay_mode: replayMode,
      custom_prompt: "",
      proactive_swap_threshold_pct: proactiveThresholdPct,
      auth_mode: "keychain_copy" as const,
    };
  }

  it("restarts stable proactive swaps with --resume and no continuation prompt", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "silent";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn((account: { name: string }) => account.name === "primary"),
      isAccountUsageExhausted: vi.fn(() => false),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, 1),
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    expect(state.active_account).toBe("primary");
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.argv).toContain(PROMPT);
    expect(launches[0]!.sessionId).toBeTruthy();
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).not.toContain(PROMPT);
    expect(launches[1]!.argv).not.toContain(DEFAULT_CONTINUE_PROMPT);
  }, 12000);

  it("restarts active proactive swaps with --resume and a continuation prompt", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "busy";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn((account: { name: string }) => account.name === "primary"),
      isAccountUsageExhausted: vi.fn(() => false),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, 1),
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).not.toContain(PROMPT);
    expect(launches[1]!.argv).toContain(DEFAULT_CONTINUE_PROMPT);
  }, 12000);

  it("restarts hard-limit swaps with --resume and last prompt replay", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "hard-limit";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => true),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, null),
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    expect(state.active_account).toBe("primary");
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.sessionId).toBeTruthy();
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).toContain(PROMPT);
  }, 12000);

  it("restarts hard-limit swaps in continue mode with a continuation prompt", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "hard-limit";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => true),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, null, "continue"),
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    expect(state.active_account).toBe("primary");
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.sessionId).toBeTruthy();
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).not.toContain(PROMPT);
    expect(launches[1]!.argv).toContain(DEFAULT_CONTINUE_PROMPT);
  }, 12000);

  it("restarts hard-limit swaps with the selected session runtime replay settings", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "hard-limit";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    process.env.FAKE_CLAUDE_RUNTIME_REPLAY = "custom_prompt";
    process.env.FAKE_CLAUDE_RUNTIME_PROMPT = "session custom go";
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => true),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, null, "last_prompt"),
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).toContain("session custom go");
    expect(launches[1]!.argv).not.toContain(PROMPT);
  }, 12000);

  it("applies a requested account switch by resuming the same session with the selected replay settings", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "manual";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    process.env.FAKE_CLAUDE_REQUEST_ACCOUNT = "backup";
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => false),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");
    const { loadState, saveState } = await import("../src/core/state.js");

    const state = { active_account: "primary", last_account: "primary" };
    saveState(state);
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, null, "continue"),
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    expect(state.active_account).toBe("primary");
    expect(loadState().active_account).toBe("primary");
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).not.toContain(PROMPT);
    expect(launches[1]!.argv).toContain(DEFAULT_CONTINUE_PROMPT);
  }, 12000);

  it("applies a stable requested account switch without replay prompt", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "manual";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    process.env.FAKE_CLAUDE_REQUEST_ACCOUNT = "backup";
    process.env.FAKE_CLAUDE_REQUEST_DELAY_MS = "2500";
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => false),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, null, "continue"),
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).not.toContain(PROMPT);
    expect(launches[1]!.argv).not.toContain(DEFAULT_CONTINUE_PROMPT);
  }, 12000);

  it("does not inject or resume a generated session for empty interactive launches", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "manual";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    process.env.FAKE_CLAUDE_REQUEST_ACCOUNT = "backup";
    process.env.FAKE_CLAUDE_REQUEST_DELAY_MS = "2500";
    process.env.FAKE_CLAUDE_CREATE_EMPTY_TRANSCRIPT = "1";
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => false),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config: baseConfig(fakeClaude, null, "continue"),
      state,
      originalArgs: [],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.argv).not.toContain("--session-id");
    expect(launches[1]!.argv).not.toContain("--resume");
    expect(launches[1]!.argv).not.toContain("--session-id");
    expect(launches[1]!.argv).not.toContain(DEFAULT_CONTINUE_PROMPT);
  }, 12000);

  it("applies a requested account added after the session started", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "manual";
    process.env.FAKE_CLAUDE_PROMPT = PROMPT;
    process.env.FAKE_CLAUDE_DYNAMIC_REQUEST_ACCOUNT = "backup";
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => false),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");

    const config = baseConfig(fakeClaude, null, "continue");
    config.accounts = [config.accounts[0]!];
    const state = { active_account: "primary", last_account: "primary" };
    const exitCode = await runClaudeSession({
      config,
      state,
      originalArgs: [PROMPT],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(0);
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.argv.slice(0, 2)).toEqual(["--resume", launches[0]!.sessionId]);
    expect(launches[1]!.argv).toContain(DEFAULT_CONTINUE_PROMPT);
  }, 12000);

  it("marks the account for re-login when Claude reports an auth failure", async () => {
    const logPath = join(tempRoot, "launches.jsonl");
    process.env.FAKE_CLAUDE_LOG = logPath;
    process.env.FAKE_CLAUDE_COUNTER = join(tempRoot, "counter");
    process.env.FAKE_CLAUDE_MODE = "auth-failure";
    const fakeClaude = createFakeClaude(tempRoot);

    vi.doMock("../src/core/usage.js", () => ({
      isAccountUsageAtOrAbove: vi.fn(() => false),
      isAccountUsageExhausted: vi.fn(() => false),
    }));
    const { runClaudeSession } = await import("../src/claude/session.js");
    const { loadConfig, saveConfig } = await import("../src/core/config.js");

    const state = { active_account: "primary", last_account: "primary" };
    const config = baseConfig(fakeClaude, null, "continue");
    saveConfig(config);
    const exitCode = await runClaudeSession({
      config,
      state,
      originalArgs: [],
      launchCwd: tempRoot,
    });

    expect(exitCode).toBe(1);
    const launches = readLaunches(logPath);
    expect(launches).toHaveLength(1);
    const cfg = loadConfig();
    expect(cfg.accounts[0]?.auth_error_reason).toBe("401 unauthorized");
    expect(cfg.accounts[0]?.auth_error_at).toBeTruthy();
    expect(cfg.accounts[1]?.auth_error_at).toBeUndefined();
  }, 12000);
});
