import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LimitDetector } from "../src/claude/limit-detector.js";
import { buildResumeArgs, normalizeCliArgs, splitPromptFromArgs } from "../src/claude/args.js";
import { buildRuntimeHookSettings, injectRuntimeSettings } from "../src/claude/hooks.js";
import {
  loadRuntimeState,
  runtimeSettingsPath,
  runtimeStatePath,
  saveRuntimeState,
  updateRuntimeState,
  type SessionRuntimeState,
} from "../src/core/runtime.js";

describe("LimitDetector", () => {
  it("matches known limit patterns", () => {
    const d = new LimitDetector();
    d.feed("hello\n");
    expect(d.matched).toBe(false);
    d.feed("Error: You've hit your limit. Try again later.\n");
    expect(d.matched).toBe(true);
  });

  it("matches rate limit patterns case-insensitively", () => {
    const d = new LimitDetector();
    d.feed("API ERROR: Rate Limit Reached\n");
    expect(d.matched).toBe(true);
  });

  it("is idempotent after first match", () => {
    const d = new LimitDetector();
    d.feed("usage limit reached");
    const first = d.matchedText;
    d.feed("other text");
    expect(d.matchedText).toBe(first);
  });

  it("resets cleanly", () => {
    const d = new LimitDetector();
    d.feed("rate limit reached");
    expect(d.matched).toBe(true);
    d.reset();
    expect(d.matched).toBe(false);
  });

  it("handles multi-chunk boundaries", () => {
    const d = new LimitDetector();
    d.feed("you've hit your ");
    expect(d.matched).toBe(false);
    d.feed("limit\n");
    expect(d.matched).toBe(true);
  });
});

describe("splitPromptFromArgs", () => {
  it("splits trailing positional prompt", () => {
    expect(splitPromptFromArgs(["--model", "sonnet", "hello"])).toEqual({
      args: ["--model", "sonnet"],
      prompt: "hello",
    });
  });

  it("treats bare flags without value", () => {
    expect(splitPromptFromArgs(["-c", "run it"])).toEqual({
      args: ["-c"],
      prompt: "run it",
    });
  });

  it("handles --key=value form without swallowing next token", () => {
    expect(splitPromptFromArgs(["--model=haiku", "go"])).toEqual({
      args: ["--model=haiku"],
      prompt: "go",
    });
  });

  it("returns null prompt when no positional", () => {
    expect(splitPromptFromArgs(["--model", "sonnet"])).toEqual({
      args: ["--model", "sonnet"],
      prompt: null,
    });
  });
});

describe("buildResumeArgs", () => {
  const base: SessionRuntimeState = {
    run_id: "r",
    session_id: "abc-123",
    last_prompt: "do the thing",
    last_prompt_at: null,
    detector_armed: true,
    cwd: null,
    active_account: null,
    replay_mode: "last_prompt",
    custom_prompt: null,
    started_at: null,
    claude_pid: null,
  };

  it("returns original args without session_id", () => {
    const noSession: SessionRuntimeState = { ...base, session_id: null };
    expect(buildResumeArgs(["--model", "sonnet"], noSession)).toEqual(["--model", "sonnet"]);
  });

  it("injects --resume with last_prompt replay", () => {
    const result = buildResumeArgs(["--model", "sonnet"], base);
    expect(result).toEqual(["--resume", "abc-123", "--model", "sonnet", "do the thing"]);
  });

  it("strips existing --resume/--session-id flags", () => {
    const result = buildResumeArgs(
      ["--resume", "old-id", "--model", "sonnet"],
      base,
    );
    expect(result).toEqual(["--resume", "abc-123", "--model", "sonnet", "do the thing"]);
  });

  it("honors custom_prompt replay mode", () => {
    const state: SessionRuntimeState = {
      ...base,
      replay_mode: "custom_prompt",
      custom_prompt: "custom go",
      last_prompt: "ignored",
    };
    const result = buildResumeArgs([], state);
    expect(result).toEqual(["--resume", "abc-123", "custom go"]);
  });

  it("skips resume injection in --print mode", () => {
    const result = buildResumeArgs(["-p", "hi"], base);
    expect(result).toEqual(["-p", "hi"]);
  });
});

describe("normalizeCliArgs", () => {
  it("rewrites `claude` alias to `run --`", () => {
    expect(normalizeCliArgs(["claude", "--model", "sonnet"])).toEqual(["run", "--", "--model", "sonnet"]);
  });

  it("passes through non-claude commands", () => {
    expect(normalizeCliArgs(["login", "work"])).toEqual(["login", "work"]);
  });

  it("handles `claude` with no trailing args", () => {
    expect(normalizeCliArgs(["claude"])).toEqual(["run"]);
  });
});

describe("hook settings", () => {
  it("builds SessionStart/UserPromptSubmit hooks with quoted paths", () => {
    process.env["CCSWAP_HOOK_CMD"] = "node /tmp/ccswap/dist/cli.js";
    const settings = buildRuntimeHookSettings("run-1", "/tmp/ccswap/runtime/run-1.json");
    expect(settings.hooks?.["SessionStart"]?.[0]?.hooks[0]?.command).toContain("hook session-start");
    expect(settings.hooks?.["SessionStart"]?.[0]?.hooks[0]?.command).toContain("run-1");
    expect(settings.hooks?.["UserPromptSubmit"]?.[0]?.hooks[0]?.command).toContain("hook prompt-submit");
    delete process.env["CCSWAP_HOOK_CMD"];
  });

  it("merges existing --settings with runtime hooks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-hooks-"));
    const existing = join(tmp, "existing.json");
    const target = join(tmp, "out.json");
    const writes: Record<string, string> = {};

    const existingSettings = {
      env: { FOO: "bar" },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] },
    };
    require("node:fs").writeFileSync(existing, JSON.stringify(existingSettings));

    const args = injectRuntimeSettings(
      ["--model", "sonnet", "--settings", existing],
      "run-2",
      "/tmp/state.json",
      target,
      (path, content) => {
        writes[path] = content;
      },
    );

    expect(args.slice(-2)).toEqual(["--settings", target]);
    expect(args).toEqual(["--model", "sonnet", "--settings", target]);
    const parsed = JSON.parse(writes[target] ?? "{}");
    expect(parsed.env).toEqual({ FOO: "bar" });
    expect(parsed.hooks.SessionStart).toHaveLength(2);
    expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);

    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("runtime state persistence", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-runtime-"));
    vi.resetModules();
    process.env.CCSWAP_CONFIG_DIR = tempRoot;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.CCSWAP_CONFIG_DIR;
  });

  it("round-trips and patches state", async () => {
    const { runtimeStatePath: pathFn, saveRuntimeState: save, loadRuntimeState: load, updateRuntimeState: patch } = await import(
      "../src/core/runtime.js"
    );

    const path = pathFn("run-x");
    save(path, {
      run_id: "run-x",
      session_id: null,
      last_prompt: null,
      last_prompt_at: null,
      detector_armed: false,
      cwd: "/tmp",
      active_account: "work",
      replay_mode: "last_prompt",
      custom_prompt: null,
      started_at: "2026-04-20T00:00:00Z",
      claude_pid: null,
    });

    const loaded = load(path, "run-x");
    expect(loaded.active_account).toBe("work");

    const patched = patch(path, "run-x", { session_id: "sess-1", claude_pid: 42 });
    expect(patched.session_id).toBe("sess-1");
    expect(patched.claude_pid).toBe(42);
    expect(patched.active_account).toBe("work");

    const persisted = JSON.parse(readFileSync(path, "utf-8")) as SessionRuntimeState;
    expect(persisted.session_id).toBe("sess-1");
  });

  it("settings path sibling to state path", async () => {
    const { runtimeStatePath: stPath, runtimeSettingsPath: sePath } = await import("../src/core/runtime.js");
    const a = stPath("abc");
    const b = sePath("abc");
    expect(a.replace(".json", ".settings.json")).toBe(b);
  });
});
