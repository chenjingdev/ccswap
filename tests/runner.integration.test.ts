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
    expect(result.proactiveSwapNeedsPrompt).toBe(false);
    expect(result.exitCode).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("detects Claude auth failures without treating them as limits", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = `console.error("Error: 401 Unauthorized"); process.exit(1);`;
    let detected: string | null = null;

    const result = await runClaude({
      claudeBin: NODE_BIN,
      args: nodeArgs(script),
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => true,
      shouldConfirmLimit: () => true,
      onAuthFailure: (failure) => {
        detected = failure.reason;
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.limitHit).toBe(false);
    expect(result.authFailure?.kind).toBe("unauthorized");
    expect(detected).toBe("401 unauthorized");
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

  it("exits for a proactive account swap after the quiet window", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = `console.log("idle"); setTimeout(() => {}, 20000);`;
    let pending = 0;
    let boundary = 0;

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
      onProactiveSwapPending: () => {
        pending += 1;
      },
      onProactiveSwapBoundary: () => {
        boundary += 1;
      },
      proactiveQuietMs: 200,
    });
    const elapsed = Date.now() - start;

    expect(result.limitHit).toBe(false);
    expect(result.proactiveSwap).toBe(true);
    expect(result.proactiveSwapNeedsPrompt).toBe(false);
    expect(pending).toBe(1);
    expect(boundary).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
    expect(elapsed).toBeLessThan(7000);
    rmSync(tmp, { recursive: true, force: true });
  }, 10000);

  it("does not exit immediately while proactive output is still active", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = [
      `let i = 0;`,
      `const iv = setInterval(() => { console.log("busy", i++); }, 100);`,
      `setTimeout(() => clearInterval(iv), 2600);`,
      `setTimeout(() => {}, 20000);`,
    ].join("");
    let pending = 0;
    let boundary = 0;

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
      onProactiveSwapPending: () => {
        pending += 1;
      },
      onProactiveSwapBoundary: () => {
        boundary += 1;
      },
      proactiveQuietMs: 700,
      proactiveMaxWaitMs: 10000,
    });
    const elapsed = Date.now() - start;

    expect(result.limitHit).toBe(false);
    expect(result.proactiveSwap).toBe(true);
    expect(result.proactiveSwapNeedsPrompt).toBe(true);
    expect(pending).toBe(1);
    expect(boundary).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(8000);
    rmSync(tmp, { recursive: true, force: true });
  }, 12000);

  it("forces proactive exit after max wait when output never goes quiet", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = [
      `let i = 0;`,
      `setInterval(() => { console.log("busy", i++); }, 250);`,
      `setTimeout(() => {}, 20000);`,
    ].join("");
    let pending = 0;

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
      onProactiveSwapPending: () => {
        pending += 1;
      },
      proactiveQuietMs: 5000,
      proactiveMaxWaitMs: 300,
    });
    const elapsed = Date.now() - start;

    expect(result.limitHit).toBe(false);
    expect(result.proactiveSwap).toBe(true);
    expect(result.proactiveSwapNeedsPrompt).toBe(true);
    expect(pending).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(8000);
    rmSync(tmp, { recursive: true, force: true });
  }, 12000);

  it("keeps the child alive when proactive swap is handled externally", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const script = `console.log("idle"); setTimeout(() => process.exit(0), 2800);`;
    let handled = 0;
    let pending = 0;

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
      onProactiveSwap: () => {
        handled += 1;
        return true;
      },
      onProactiveSwapPending: () => {
        pending += 1;
      },
    });
    const elapsed = Date.now() - start;

    expect(handled).toBeGreaterThan(0);
    expect(pending).toBe(0);
    expect(result.limitHit).toBe(false);
    expect(result.proactiveSwap).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(2500);
    rmSync(tmp, { recursive: true, force: true });
  }, 10000);
});
