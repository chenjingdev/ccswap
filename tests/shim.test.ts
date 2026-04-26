import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe.skipIf(process.platform === "win32")("claude shim", () => {
  let tempRoot: string;
  let binDir: string;
  let oldPath: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "ccswap-shim-"));
    binDir = join(tempRoot, "bin");
    vi.resetModules();
    oldPath = process.env.PATH;
    process.env.CCSWAP_CONFIG_DIR = join(tempRoot, "config");
    process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.CCSWAP_CONFIG_DIR;
    process.env.PATH = oldPath;
  });

  function writeExecutable(path: string, body = "#!/bin/sh\nexit 0\n"): void {
    writeFileSync(path, body, { encoding: "utf-8", mode: 0o755 });
    chmodSync(path, 0o755);
  }

  it("wraps the current claude command and saves the real binary path", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    const realClaude = join(tempRoot, "real-claude");
    const ccswapBin = join(tempRoot, "ccswap");
    writeExecutable(realClaude);
    writeExecutable(ccswapBin);
    symlinkSync(realClaude, join(binDir, "claude"));
    const resolvedRealClaude = realpathSync(realClaude);

    const { installClaudeShim, isCcswapShim } = await import("../src/core/shim.js");
    const result = installClaudeShim({ ccswapBin });

    expect(result.shimPath).toBe(join(binDir, "claude"));
    expect(result.realClaudePath).toBe(resolvedRealClaude);
    expect(result.backupPath).toBe(join(binDir, "claude.ccswap-real"));
    expect(isCcswapShim(join(binDir, "claude"))).toBe(true);
    expect(lstatSync(join(binDir, "claude.ccswap-real")).isSymbolicLink()).toBe(true);

    const script = readFileSync(join(binDir, "claude"), "utf-8");
    expect(script).toContain("ccswap claude connector");
    expect(script).toContain(`CCSWAP_REAL_CLAUDE='${resolvedRealClaude}'`);
    expect(script).toContain(`CCSWAP_BIN='${ccswapBin}'`);
    expect(script).toContain('exec "$CCSWAP_BIN" claude "$@"');

    const { loadConfig } = await import("../src/core/config.js");
    expect(loadConfig().claude_bin).toBe(resolvedRealClaude);
  });

  it("wraps a regular claude executable by moving it to the backup path first", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    const claudePath = join(binDir, "claude");
    const ccswapBin = join(tempRoot, "ccswap");
    writeExecutable(claudePath, "#!/bin/sh\necho real-claude\n");
    writeExecutable(ccswapBin);

    const { installClaudeShim, isCcswapShim } = await import("../src/core/shim.js");
    const result = installClaudeShim({ ccswapBin });

    expect(result.shimPath).toBe(claudePath);
    expect(result.realClaudePath).toBe(join(binDir, "claude.ccswap-real"));
    expect(result.backupPath).toBe(join(binDir, "claude.ccswap-real"));
    expect(isCcswapShim(claudePath)).toBe(true);
    expect(readFileSync(result.realClaudePath, "utf-8")).toContain("real-claude");

    const { loadConfig } = await import("../src/core/config.js");
    expect(loadConfig().claude_bin).toBe(result.realClaudePath);
  });

  it("ensure installs a connector over a regular claude executable", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    const claudePath = join(binDir, "claude");
    const ccswapBin = join(tempRoot, "ccswap");
    writeExecutable(claudePath, "#!/bin/sh\necho real-claude\n");
    writeExecutable(ccswapBin);

    const { ensureClaudeShim, isCcswapShim } = await import("../src/core/shim.js");
    const result = ensureClaudeShim({ ccswapBin });

    expect(result.kind).toBe("installed");
    expect(result.status.onPath).toBe(true);
    expect(result.status.realClaudePath).toBe(join(binDir, "claude.ccswap-real"));
    expect(isCcswapShim(claudePath)).toBe(true);
  });

  it("removes the shim and restores the backup", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    const realClaude = join(tempRoot, "real-claude");
    const ccswapBin = join(tempRoot, "ccswap");
    writeExecutable(realClaude);
    writeExecutable(ccswapBin);
    symlinkSync(realClaude, join(binDir, "claude"));

    const { installClaudeShim, removeClaudeShim, isCcswapShim } = await import("../src/core/shim.js");
    installClaudeShim({ ccswapBin });
    removeClaudeShim();

    expect(isCcswapShim(join(binDir, "claude"))).toBe(false);
    expect(lstatSync(join(binDir, "claude")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(binDir, "claude.ccswap-real"))).toBe(false);

    const { loadConfig } = await import("../src/core/config.js");
    expect(loadConfig().claude_bin).toBe("claude");
  });

  it("does not choose app-bundle binaries as the connector install path", async () => {
    const { mkdirSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const appBin = pathJoin(tempRoot, "Applications", "Fake.app", "Contents", "Resources", "bin");
    mkdirSync(appBin, { recursive: true });
    writeExecutable(pathJoin(appBin, "claude"));

    const { defaultShimPath } = await import("../src/core/shim.js");
    expect(defaultShimPath({ PATH: appBin })).toBe(pathJoin(homedir(), ".local", "bin", "claude"));
  });

  it("treats a cmux wrapper that delegates to the connector as connected", async () => {
    const { mkdirSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const appBin = pathJoin(tempRoot, "Applications", "cmux.app", "Contents", "Resources", "bin");
    const connectorBin = pathJoin(tempRoot, "local", "bin");
    const realClaude = pathJoin(tempRoot, "real-claude");
    const ccswapBin = pathJoin(tempRoot, "ccswap");
    mkdirSync(appBin, { recursive: true });
    mkdirSync(connectorBin, { recursive: true });
    writeExecutable(pathJoin(appBin, "claude"), "#!/usr/bin/env bash\n# cmux claude wrapper\nfind_real_claude() { :; }\n");
    writeExecutable(realClaude);
    writeExecutable(ccswapBin);

    const { installClaudeShim, getShimStatus } = await import("../src/core/shim.js");
    const shimPath = pathJoin(connectorBin, "claude");
    installClaudeShim({ shimPath, realClaudePath: realClaude, ccswapBin });
    const status = getShimStatus({
      shimPath,
      env: { PATH: `${appBin}${delimiter}${connectorBin}` },
    });

    expect(status.pathCommand).toBe(pathJoin(appBin, "claude"));
    expect(status.onPath).toBe(true);
  });

  it("ensure installs a connector when the current claude can be wrapped safely", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    const realClaude = join(tempRoot, "real-claude");
    const ccswapBin = join(tempRoot, "ccswap");
    writeExecutable(realClaude);
    writeExecutable(ccswapBin);
    symlinkSync(realClaude, join(binDir, "claude"));

    const { ensureClaudeShim, isCcswapShim } = await import("../src/core/shim.js");
    const result = ensureClaudeShim({ ccswapBin });

    expect(result.kind).toBe("installed");
    expect(result.status.onPath).toBe(true);
    expect(isCcswapShim(join(binDir, "claude"))).toBe(true);
  });

  it("ensure is a no-op when the connector is already active on PATH", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    const realClaude = join(tempRoot, "real-claude");
    const ccswapBin = join(tempRoot, "ccswap");
    writeExecutable(realClaude);
    writeExecutable(ccswapBin);
    symlinkSync(realClaude, join(binDir, "claude"));

    const { ensureClaudeShim, installClaudeShim } = await import("../src/core/shim.js");
    installClaudeShim({ ccswapBin });
    const result = ensureClaudeShim({ ccswapBin });

    expect(result.kind).toBe("connected");
    expect(result.install).toBeUndefined();
    expect(result.status.onPath).toBe(true);
  });

  it("ensure reports backup conflicts instead of overwriting on startup", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(join(binDir, "claude"));
    writeExecutable(join(binDir, "claude.ccswap-real"));

    const { ensureClaudeShim, isCcswapShim } = await import("../src/core/shim.js");
    const result = ensureClaudeShim();

    expect(result.kind).toBe("backup_conflict");
    expect(isCcswapShim(join(binDir, "claude"))).toBe(false);
  });

  it("ensure reports PATH conflicts without installing behind another claude", async () => {
    const { mkdirSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    const appBin = pathJoin(tempRoot, "Applications", "Fake.app", "Contents", "Resources", "bin");
    const connectorBin = pathJoin(tempRoot, "local", "bin");
    mkdirSync(appBin, { recursive: true });
    mkdirSync(connectorBin, { recursive: true });
    writeExecutable(pathJoin(appBin, "claude"));

    const { ensureClaudeShim } = await import("../src/core/shim.js");
    const shimPath = pathJoin(connectorBin, "claude");
    const result = ensureClaudeShim({
      shimPath,
      env: { PATH: `${appBin}${delimiter}${connectorBin}` },
    });

    expect(result.kind).toBe("path_conflict");
    expect(existsSync(shimPath)).toBe(false);
  });
});
