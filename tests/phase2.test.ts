import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTINUE_PROMPT } from "../src/core/constants.js";
import { detectClaudeAuthFailure } from "../src/claude/auth-failure.js";
import { LimitDetector } from "../src/claude/limit-detector.js";
import {
  buildResumeArgs,
  normalizeCliArgs,
  resolveSessionDirective,
  splitPromptFromArgs,
} from "../src/claude/args.js";
import {
  encodeClaudeProjectDir,
  extractLastUserPrompt,
  startSessionWatcher,
} from "../src/claude/session-watcher.js";
import {
  loadRuntimeState,
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

describe("detectClaudeAuthFailure", () => {
  it("detects real auth failure output", () => {
    expect(detectClaudeAuthFailure("Error: 401 Unauthorized")?.kind).toBe("unauthorized");
    expect(detectClaudeAuthFailure("OAuth token has expired")?.kind).toBe("oauth_expired");
  });

  it("does not treat ordinary HTTP discussion as a login failure", () => {
    expect(detectClaudeAuthFailure("HTTP 401 Unauthorized usually means auth failed in a web API.")).toBeNull();
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
    ccswap_pid: null,
    claude_pid: null,
    swap_pending: false,
    swap_reason: null,
    swap_requested_at: null,
    last_activity_at: null,
    safe_to_restart: false,
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

  it("strips inline --resume=/--session-id= forms", () => {
    const result = buildResumeArgs(
      ["--resume=old-id", "--session-id=stale-uuid", "--model", "sonnet"],
      base,
    );
    // The stale inline flags must NOT survive — otherwise Claude sees both the
    // ccswap-supplied anchor and the user's old one and picks nondeterministically.
    expect(result).toEqual(["--resume", "abc-123", "--model", "sonnet", "do the thing"]);
  });

  it("strips a bare trailing -r with no following value", () => {
    const result = buildResumeArgs(["--model", "sonnet", "-r"], base);
    expect(result).toEqual(["--resume", "abc-123", "--model", "sonnet", "do the thing"]);
  });

  it("does not swallow a flag that follows --resume as if it were the id", () => {
    // `--resume --fork-session` — user wanted resume-with-picker + fork, but
    // the naive strip would eat --fork-session as the id value.
    const result = buildResumeArgs(["--resume", "--fork-session"], base);
    expect(result).toEqual(["--resume", "abc-123", "--fork-session", "do the thing"]);
  });

  it("keeps session-ish tokens that are another flag's value", () => {
    // `--append-system-prompt --resume=foo` — `--resume=foo` is literal text
    // for the system prompt, not a session directive. The strip must ignore it.
    const result = buildResumeArgs(
      ["--append-system-prompt", "--resume=foo", "--model", "sonnet"],
      base,
    );
    expect(result).toEqual([
      "--resume",
      "abc-123",
      "--append-system-prompt",
      "--resume=foo",
      "--model",
      "sonnet",
      "do the thing",
    ]);
  });

  it("keeps a bare --session-id token that is a value for another flag", () => {
    // Space form, same concern as above.
    const result = buildResumeArgs(
      ["--append-system-prompt", "--session-id", "--model", "sonnet"],
      base,
    );
    expect(result).toEqual([
      "--resume",
      "abc-123",
      "--append-system-prompt",
      "--session-id",
      "--model",
      "sonnet",
      "do the thing",
    ]);
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

  it("uses --resume with a continuation prompt for proactive relaunches", () => {
    const state: SessionRuntimeState = {
      ...base,
      replay_mode: "continue",
      last_prompt: null,
      custom_prompt: null,
    };
    const result = buildResumeArgs(["--model", "sonnet", "old prompt"], state, false);
    expect(result).toEqual(["--resume", "abc-123", "--model", "sonnet", DEFAULT_CONTINUE_PROMPT]);
  });

  it("uses --resume without replay prompt for stable relaunches", () => {
    const state: SessionRuntimeState = {
      ...base,
      replay_mode: "continue",
      last_prompt: null,
      custom_prompt: null,
    };
    const result = buildResumeArgs(["--model", "sonnet", "old prompt"], state, false, false);
    expect(result).toEqual(["--resume", "abc-123", "--model", "sonnet"]);
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

describe("resolveSessionDirective", () => {
  it("reports none when no session flags are present", () => {
    expect(resolveSessionDirective(["--model", "sonnet", "hello"])).toEqual({ kind: "none" });
  });

  it("pulls id out of --session-id <uuid>", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(resolveSessionDirective(["--session-id", id])).toEqual({
      kind: "user-provided",
      sessionId: id,
    });
  });

  it("pulls id out of --session-id=<uuid>", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    expect(resolveSessionDirective([`--session-id=${id}`])).toEqual({
      kind: "user-provided",
      sessionId: id,
    });
  });

  it("pulls id out of --resume <uuid> and -r <uuid>", () => {
    expect(resolveSessionDirective(["--resume", "abc"])).toEqual({
      kind: "user-provided",
      sessionId: "abc",
    });
    expect(resolveSessionDirective(["-r", "xyz"])).toEqual({
      kind: "user-provided",
      sessionId: "xyz",
    });
  });

  it("treats -c / --continue as resume-without-id", () => {
    expect(resolveSessionDirective(["-c"])).toEqual({ kind: "user-continue" });
    expect(resolveSessionDirective(["--continue", "hi"])).toEqual({ kind: "user-continue" });
  });

  it("defers to Claude when --resume is followed by another flag", () => {
    // `--resume --fork-session` — user wants resume-with-picker + fork. Must
    // NOT trigger ccswap's --session-id injection, or the picker breaks.
    expect(resolveSessionDirective(["--resume", "--fork-session"])).toEqual({
      kind: "user-continue",
    });
  });

  it("treats bare --resume / -r as defer-to-Claude so the picker still works", () => {
    // Regression: bare resume must not make ccswap inject a new --session-id
    // alongside, because Claude then sees two conflicting session directives.
    expect(resolveSessionDirective(["--resume"])).toEqual({ kind: "user-continue" });
    expect(resolveSessionDirective(["-r"])).toEqual({ kind: "user-continue" });
    expect(resolveSessionDirective(["--model", "sonnet", "-r"])).toEqual({
      kind: "user-continue",
    });
  });

  it("defers to Claude when --session-id is followed by another flag", () => {
    // `--session-id --debug` — Claude will error, but ccswap must not add its
    // own --session-id alongside.
    expect(resolveSessionDirective(["--session-id", "--debug"])).toEqual({
      kind: "user-continue",
    });
    expect(resolveSessionDirective(["--session-id", "-c"])).toEqual({
      kind: "user-continue",
    });
  });

  it("ignores a session-ish token that is another flag's value", () => {
    // `--append-system-prompt --resume=foo` → `--resume=foo` is literal text
    // for the system prompt, not a user-provided session id.
    expect(
      resolveSessionDirective(["--append-system-prompt", "--resume=foo"]),
    ).toEqual({ kind: "none" });
    expect(
      resolveSessionDirective(["--append-system-prompt", "--session-id=bar"]),
    ).toEqual({ kind: "none" });
    expect(
      resolveSessionDirective(["--model", "sonnet", "--session-id", "abc"]),
    ).toEqual({ kind: "user-provided", sessionId: "abc" });
  });
});

describe("session watcher helpers", () => {
  it("encodes cwd matching Claude Code's projects dir convention", () => {
    expect(encodeClaudeProjectDir("/Users/me/dev/proj")).toBe("-Users-me-dev-proj");
    // Non-ASCII chars (e.g., Hangul) collapse into one dash per char.
    expect(encodeClaudeProjectDir("/Users/me/dev/모나와/이력서")).toBe(
      "-Users-me-dev--------",
    );
    // Dots, spaces and other symbols are also replaced.
    expect(encodeClaudeProjectDir("/tmp/my.app dir")).toBe("-tmp-my-app-dir");
  });

  it("extracts the most recent real user prompt from a jsonl transcript", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-watcher-"));
    const file = join(tmp, "a.jsonl");
    const lines = [
      // initial bookkeeping entry Claude Code writes on startup
      { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: "a" },
      // a real user prompt — oldest
      {
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "first question" },
        timestamp: "2026-04-21T12:00:00Z",
      },
      // sidechain (agent) prompt — must be ignored
      {
        type: "user",
        isSidechain: true,
        message: { role: "user", content: "agent-only prompt" },
        timestamp: "2026-04-21T12:00:30Z",
      },
      // synthetic local command entry — must be ignored
      {
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "<command-name>/clear</command-name>" },
        timestamp: "2026-04-21T12:00:45Z",
      },
      // tool_result coming back on the user channel — must be ignored
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "x", content: "ok" },
          ],
        },
        timestamp: "2026-04-21T12:01:00Z",
      },
      // latest real user prompt, wrapped in a system-reminder that should be stripped
      {
        type: "user",
        isSidechain: false,
        message: {
          role: "user",
          content: "<system-reminder>hook fired</system-reminder>\n\nactual latest question",
        },
        timestamp: "2026-04-21T12:02:00Z",
      },
    ];
    writeFileSync(file, lines.map((o) => JSON.stringify(o)).join("\n") + "\n");

    const result = extractLastUserPrompt(file);
    expect(result?.text).toBe("actual latest question");
    expect(result?.timestamp).toBe("2026-04-21T12:02:00Z");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when the transcript has no real user prompt", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-watcher-"));
    const file = join(tmp, "b.jsonl");
    writeFileSync(
      file,
      JSON.stringify({ type: "permission-mode", sessionId: "b" }) + "\n",
    );
    expect(extractLastUserPrompt(file)).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("startSessionWatcher", () => {
  const LAUNCH_CWD = "/Users/ccswap-test/proj";
  const ENCODED = "-Users-ccswap-test-proj";

  function setupFakeHome(): { home: string; projectDir: string; runtimeDir: string } {
    const home = mkdtempSync(join(tmpdir(), "ccswap-home-"));
    const projectDir = join(home, ".claude", "projects", ENCODED);
    mkdirSync(projectDir, { recursive: true });
    const runtimeDir = mkdtempSync(join(tmpdir(), "ccswap-rt-"));
    process.env.HOME = home;
    return { home, projectDir, runtimeDir };
  }

  function writeJsonl(path: string, entries: unknown[], mtimeSec?: number): void {
    writeFileSync(path, entries.map((o) => JSON.stringify(o)).join("\n") + "\n");
    if (mtimeSec !== undefined) {
      utimesSync(path, mtimeSec, mtimeSec);
    }
  }

  function makePromptLine(content: string, timestamp: string) {
    return {
      type: "user",
      isSidechain: false,
      message: { role: "user", content },
      timestamp,
    };
  }

  function writeState(path: string, sessionId: string | null): void {
    writeFileSync(
      path,
      JSON.stringify(
        {
          run_id: "run-anchor-test",
          session_id: sessionId,
          last_prompt: null,
          last_prompt_at: null,
          detector_armed: false,
          cwd: LAUNCH_CWD,
          active_account: null,
          replay_mode: "last_prompt",
          custom_prompt: null,
          started_at: new Date().toISOString(),
          ccswap_pid: null,
          claude_pid: null,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }

  const prevHome = process.env.HOME;
  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
  });

  it("ignores sibling transcripts when anchored by expectedSessionId", async () => {
    const { home, projectDir, runtimeDir } = setupFakeHome();
    const statePath = join(runtimeDir, "state.json");
    writeState(statePath, null);

    const expected = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sibling = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    // Sibling already exists and is being actively written to — the kind of
    // file the pre-fix watcher would have latched onto.
    writeJsonl(join(projectDir, `${sibling}.jsonl`), [
      { type: "permission-mode", sessionId: sibling, cwd: LAUNCH_CWD },
      makePromptLine("wrong conversation — do NOT track", "2026-04-21T13:00:00Z"),
    ]);

    // Our own transcript — appears moments after launch.
    writeJsonl(join(projectDir, `${expected}.jsonl`), [
      { type: "permission-mode", sessionId: expected, cwd: LAUNCH_CWD },
      makePromptLine("the real ccswap prompt", "2026-04-21T13:05:00Z"),
    ]);

    const handle = startSessionWatcher({
      runId: "run-anchor-test",
      statePath,
      launchCwd: LAUNCH_CWD,
      launchedAtMs: Date.now(),
      expectedSessionId: expected,
      pollMs: 40,
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.session_id).toBe(expected);
    expect(state.last_prompt).toBe("the real ccswap prompt");
    expect(state.detector_armed).toBe(true);

    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("uses the mtime snapshot to pick the advanced file when no id is pinned", async () => {
    const { home, projectDir, runtimeDir } = setupFakeHome();
    const statePath = join(runtimeDir, "state.json");
    writeState(statePath, null);

    const stale = "ccccccc1-cccc-cccc-cccc-cccccccccccc";
    const active = "ddddddd2-dddd-dddd-dddd-dddddddddddd";

    // Two pre-existing transcripts with recent mtimes — baseline before launch.
    const stalePath = join(projectDir, `${stale}.jsonl`);
    const activePath = join(projectDir, `${active}.jsonl`);
    const baseSec = Math.floor(Date.now() / 1000) - 5;
    writeJsonl(
      stalePath,
      [
        { type: "permission-mode", sessionId: stale, cwd: LAUNCH_CWD },
        makePromptLine("stale sibling — must be ignored", "2026-04-21T12:00:00Z"),
      ],
      baseSec,
    );
    writeJsonl(
      activePath,
      [
        { type: "permission-mode", sessionId: active, cwd: LAUNCH_CWD },
        makePromptLine("old prompt on would-be-active file", "2026-04-21T12:00:00Z"),
      ],
      baseSec,
    );

    const launchedAtMs = Date.now();
    const handle = startSessionWatcher({
      runId: "run-anchor-test",
      statePath,
      launchCwd: LAUNCH_CWD,
      launchedAtMs,
      expectedSessionId: null,
      pollMs: 40,
    });

    // Give the watcher one tick to baseline, then "Claude" appends to active.
    await new Promise((r) => setTimeout(r, 80));
    writeJsonl(
      activePath,
      [
        { type: "permission-mode", sessionId: active, cwd: LAUNCH_CWD },
        makePromptLine("advanced after launch", "2026-04-21T13:10:00Z"),
      ],
    );
    // Bump mtime explicitly to beat fs timestamp granularity.
    utimesSync(activePath, Date.now() / 1000, Date.now() / 1000);

    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.session_id).toBe(active);
    expect(state.last_prompt).toBe("advanced after launch");

    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  });

  it("does not publish an unanchored session id until the transcript has a real prompt", async () => {
    const { home, projectDir, runtimeDir } = setupFakeHome();
    const statePath = join(runtimeDir, "state.json");
    writeState(statePath, null);

    const active = "eeeeeee3-eeee-eeee-eeee-eeeeeeeeeeee";
    const activePath = join(projectDir, `${active}.jsonl`);

    const handle = startSessionWatcher({
      runId: "run-anchor-test",
      statePath,
      launchCwd: LAUNCH_CWD,
      launchedAtMs: Date.now(),
      expectedSessionId: null,
      pollMs: 40,
    });

    writeJsonl(activePath, [
      { type: "permission-mode", sessionId: active, cwd: LAUNCH_CWD },
    ]);
    utimesSync(activePath, Date.now() / 1000, Date.now() / 1000);
    await new Promise((r) => setTimeout(r, 160));

    let state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.session_id).toBeNull();
    expect(state.last_prompt).toBeNull();

    writeJsonl(activePath, [
      { type: "permission-mode", sessionId: active, cwd: LAUNCH_CWD },
      makePromptLine("now it is resumable", "2026-04-21T13:20:00Z"),
    ]);
    utimesSync(activePath, Date.now() / 1000, Date.now() / 1000);
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();

    state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.session_id).toBe(active);
    expect(state.last_prompt).toBe("now it is resumable");

    rmSync(home, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
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
      ccswap_pid: null,
      claude_pid: null,
      swap_pending: false,
      swap_reason: null,
      swap_requested_at: null,
      last_activity_at: null,
      safe_to_restart: false,
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

});
