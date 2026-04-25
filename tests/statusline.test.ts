import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccountData } from "../src/core/config.js";
import {
  extractSettingsPath,
  stripSettingsArgs,
  withUsageCaptureSettingsArgs,
  writeUsageCaptureSettings,
} from "../src/core/statusline.js";

describe("statusline usage capture settings", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccswap-statusline-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("extracts and strips existing --settings args", () => {
    expect(extractSettingsPath(["--model", "sonnet", "--settings", "base.json"])).toBe("base.json");
    expect(extractSettingsPath(["--settings=base.json"])).toBe("base.json");
    expect(stripSettingsArgs(["--model", "sonnet", "--settings", "base.json", "hi"])).toEqual([
      "--model",
      "sonnet",
      "hi",
    ]);
    expect(withUsageCaptureSettingsArgs(["--settings=base.json", "hi"], "runtime.json")).toEqual([
      "hi",
      "--settings",
      "runtime.json",
    ]);
  });

  it("wraps an existing statusLine command with usage capture", () => {
    const base = join(tmp, "base.json");
    const runtime = join(tmp, "runtime.json");
    writeFileSync(
      base,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "node old-statusline.js",
          padding: 2,
        },
        permissions: { allow: ["Bash(ls)"] },
      }),
    );
    const account: AccountData = {
      name: "work@example.com",
      claude_config_dir: join(tmp, "claude"),
      auto_swap: true,
      keychain_service: "service",
      keychain_account: "account",
      email: "work@example.com",
    };
    writeUsageCaptureSettings(account, runtime, ["--settings", base]);
    const parsed = JSON.parse(readFileSync(runtime, "utf-8")) as {
      statusLine: { command: string; padding: number };
      permissions: { allow: string[] };
    };
    expect(parsed.permissions.allow).toEqual(["Bash(ls)"]);
    expect(parsed.statusLine.padding).toBe(2);
    expect(parsed.statusLine.command).toContain("usage-capture");
    expect(parsed.statusLine.command).toContain("--account 'work@example.com'");
    expect(parsed.statusLine.command).toContain("--passthrough");
  });

  it("usage-capture CLI writes the account usage cache", () => {
    const configDir = join(tmp, "config");
    mkdirSync(configDir, { recursive: true });
    const accountName = "work@example.com";
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        accounts: [
          {
            name: accountName,
            claude_config_dir: join(tmp, "claude"),
            auto_swap: true,
            keychain_service: "service",
            keychain_account: "account",
            email: accountName,
          },
        ],
      }),
    );
    const payload = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 32503680000 },
        seven_day: { used_percentage: 34, resets_at: 32503766400 },
      },
    });
    const result = spawnSync(
      process.execPath,
      ["dist/cli.js", "usage-capture", "--account", accountName],
      {
        cwd: process.cwd(),
        env: { ...process.env, CCSWAP_CONFIG_DIR: configDir },
        input: payload,
        encoding: "utf-8",
      },
    );
    expect(result.status).toBe(0);
    const cache = JSON.parse(
      readFileSync(join(configDir, "usage-cache", "work-example.com.json"), "utf-8"),
    ) as { data: { fiveHour: number; sevenDay: number } };
    expect(cache.data.fiveHour).toBe(12);
    expect(cache.data.sevenDay).toBe(34);
  });
});
