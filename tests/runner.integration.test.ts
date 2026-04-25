import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runClaude } from "../src/claude/runner.js";

// Cross-platform "fake claude" via inline Node scripts so the test suite
// runs on POSIX and Windows without shell shebang gymnastics.
const NODE_BIN = process.execPath;

function nodeArgs(script: string): string[] {
  return ["-e", script];
}

describe("runClaude integration", () => {
  it("detects limit and terminates the child", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = [
      `console.log("starting fake claude");`,
      `console.log("API error: Rate limit reached.");`,
      // stay alive long enough to require escalation
      `setTimeout(() => {}, 20000);`,
    ].join("");

    const start = Date.now();
    const result = await runClaude({
      claudeBin: NODE_BIN,
      args: nodeArgs(script),
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => true,
      shouldConfirmLimit: () => true,
    });
    const elapsed = Date.now() - start;

    expect(result.limitHit).toBe(true);
    expect(result.proactiveSwap).toBe(false);
    // should escalate to SIGKILL within ~3.5s (grace 1s + term 1s + kill 1.5s buffer)
    expect(elapsed).toBeLessThan(6000);
    rmSync(tmp, { recursive: true, force: true });
  }, 10000);

  it("reports clean exit when no limit", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = `console.log("hello");`;

    const result = await runClaude({
      claudeBin: NODE_BIN,
      args: nodeArgs(script),
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => true,
      shouldConfirmLimit: () => true,
    });

    expect(result.limitHit).toBe(false);
    expect(result.proactiveSwap).toBe(false);
    expect(result.exitCode).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ignores limit text when shouldArmLimit returns false", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = `console.log("rate limit reached");`;

    const result = await runClaude({
      claudeBin: NODE_BIN,
      args: nodeArgs(script),
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => false,
      shouldConfirmLimit: () => true,
    });

    expect(result.limitHit).toBe(false);
    expect(result.proactiveSwap).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits for a proactive account swap without a limit message", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = `console.log("idle"); setTimeout(() => {}, 20000);`;

    const start = Date.now();
    const result = await runClaude({
      claudeBin: NODE_BIN,
      args: nodeArgs(script),
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => true,
      shouldConfirmLimit: () => true,
      shouldProactivelySwap: () => true,
    });
    const elapsed = Date.now() - start;

    expect(result.limitHit).toBe(false);
    expect(result.proactiveSwap).toBe(true);
    expect(elapsed).toBeLessThan(7000);
    rmSync(tmp, { recursive: true, force: true });
  }, 10000);
});
