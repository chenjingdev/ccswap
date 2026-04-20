import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runClaude } from "../src/claude/runner.js";

function writeFake(dir: string, script: string): string {
  const path = join(dir, "fake-claude");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe("runClaude integration", () => {
  it("detects limit and terminates the child", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const fake = writeFake(
      tmp,
      `#!/bin/bash
echo "starting fake claude"
echo "API error: Rate limit reached."
# stay alive long enough to require escalation
sleep 20
echo "should not reach"
`,
    );

    const start = Date.now();
    const result = await runClaude({
      claudeBin: fake,
      args: [],
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => true,
      shouldConfirmLimit: () => true,
    });
    const elapsed = Date.now() - start;

    expect(result.limitHit).toBe(true);
    // should escalate to SIGKILL within ~3.5s (grace 1s + term 1s + kill 1.5s buffer)
    expect(elapsed).toBeLessThan(6000);
    rmSync(tmp, { recursive: true, force: true });
  }, 10000);

  it("reports clean exit when no limit", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const fake = writeFake(
      tmp,
      `#!/bin/bash
echo "hello"
exit 0
`,
    );

    const result = await runClaude({
      claudeBin: fake,
      args: [],
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => true,
      shouldConfirmLimit: () => true,
    });

    expect(result.limitHit).toBe(false);
    expect(result.exitCode).toBe(0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ignores limit text when shouldArmLimit returns false", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ccswap-runner-"));
    const fake = writeFake(
      tmp,
      `#!/bin/bash
echo "rate limit reached"
exit 0
`,
    );

    const result = await runClaude({
      claudeBin: fake,
      args: [],
      cwd: tmp,
      env: { ...process.env },
      accountName: "fake",
      shouldArmLimit: () => false,
      shouldConfirmLimit: () => true,
    });

    expect(result.limitHit).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});
