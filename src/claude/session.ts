import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";

import type { AccountData, AppConfigData } from "../core/config.js";
import type { AppStateData } from "../core/state.js";
import { ensureDir } from "../core/fs-util.js";
import { RUNTIME_DIR } from "../core/paths.js";
import { saveState } from "../core/state.js";
import {
  activateAccountCredential,
  getAccountCredential,
} from "../core/credentials.js";
import { buildClaudeEnv } from "../core/env.js";
import { isAccountUsageExhausted } from "../core/usage.js";
import {
  cleanupStaleRuntimeSessions,
  loadRuntimeState,
  runtimeSettingsPath,
  runtimeStatePath,
  saveRuntimeState,
  updateRuntimeState,
  type SessionRuntimeState,
} from "../core/runtime.js";
import { buildResumeArgs, splitPromptFromArgs } from "./args.js";
import { injectRuntimeSettings } from "./hooks.js";
import { runClaude } from "./runner.js";

function pickLaunchAccount(accounts: AccountData[], state: AppStateData): string | null {
  if (accounts.length === 0) return null;
  const pivot = state.active_account ?? state.last_account;
  if (pivot) {
    const hit = accounts.find((a) => a.name === pivot);
    if (hit) return hit.name;
  }
  return accounts[0]?.name ?? null;
}

function pickNextAccount(
  accounts: AccountData[],
  state: AppStateData,
  exclude: Set<string>,
): string | null {
  const pivot = state.active_account ?? state.last_account;
  let ordered = accounts;
  if (pivot) {
    const idx = accounts.findIndex((a) => a.name === pivot);
    if (idx >= 0) {
      ordered = [...accounts.slice(idx + 1), ...accounts.slice(0, idx + 1)];
    }
  }
  for (const account of ordered) {
    if (exclude.has(account.name) || !account.auto_swap) continue;
    return account.name;
  }
  return null;
}

function writeSettingsFile(path: string, content: string): void {
  ensureDir(RUNTIME_DIR);
  writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
  if (platform() !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // ignore
    }
  }
}

export interface SessionOptions {
  config: AppConfigData;
  state: AppStateData;
  originalArgs: string[];
  launchCwd: string;
}

export async function runClaudeSession(opts: SessionOptions): Promise<number> {
  const { config, state } = opts;
  cleanupStaleRuntimeSessions();

  const eligible = config.accounts.filter((a) => getAccountCredential(a) !== null);
  if (eligible.length === 0) {
    process.stderr.write("[ccswap] No accounts with saved logins configured.\n");
    return 1;
  }

  let currentName = state.active_account ?? pickLaunchAccount(eligible, state);
  if (!currentName) {
    process.stderr.write("[ccswap] No eligible account is available.\n");
    return 1;
  }

  const runId = randomUUID();
  const statePath = runtimeStatePath(runId);
  const settingsPath = runtimeSettingsPath(runId);
  ensureDir(RUNTIME_DIR);

  const runtime: SessionRuntimeState = {
    run_id: runId,
    session_id: null,
    last_prompt: null,
    last_prompt_at: null,
    detector_armed: false,
    cwd: opts.launchCwd,
    active_account: currentName,
    replay_mode: config.replay_mode,
    custom_prompt: config.custom_prompt || null,
    started_at: new Date().toISOString(),
    claude_pid: null,
  };
  saveRuntimeState(statePath, runtime);

  let launchArgs = injectRuntimeSettings(opts.originalArgs, runId, statePath, settingsPath, writeSettingsFile);

  const attempted = new Set<string>();

  try {
    while (true) {
      const account = eligible.find((a) => a.name === currentName);
      if (!account) {
        process.stderr.write(`[ccswap] Missing account '${currentName}'.\n`);
        return 1;
      }

      const { prompt: launchPrompt } = splitPromptFromArgs(launchArgs);
      const detectorArmed = Boolean(launchPrompt && !launchPrompt.trimStart().startsWith("/"));

      state.active_account = account.name;
      state.last_account = account.name;
      saveState(state);

      updateRuntimeState(statePath, runId, {
        cwd: opts.launchCwd,
        active_account: account.name,
        replay_mode: config.replay_mode,
        custom_prompt: config.custom_prompt || null,
        detector_armed: detectorArmed,
      });

      const activated = activateAccountCredential(account);
      if (!activated) {
        process.stderr.write(
          `[ccswap] Account '${account.name}' has no saved Claude login. Run: ccswap login ${account.name}\n`,
        );
        return 1;
      }

      process.stderr.write(
        `[ccswap] Launching Claude with '${account.name}' in ${opts.launchCwd}\n`,
      );

      const result = await runClaude({
        claudeBin: config.claude_bin,
        args: launchArgs,
        cwd: opts.launchCwd,
        env: buildClaudeEnv(),
        accountName: account.name,
        onStarted: (pid) => {
          updateRuntimeState(statePath, runId, {
            claude_pid: pid,
            active_account: account.name,
          });
        },
        onSessionHint: (sessionId) => {
          updateRuntimeState(statePath, runId, { session_id: sessionId });
        },
        shouldArmLimit: () => loadRuntimeState(statePath, runId).detector_armed,
        shouldConfirmLimit: () => isAccountUsageExhausted(account, true),
      });

      if (!result.limitHit) {
        return result.exitCode;
      }

      attempted.add(account.name);

      const nextName = pickNextAccount(eligible, state, attempted);
      if (!nextName) {
        process.stderr.write(
          `[ccswap] '${account.name}' hit its limit and no backup account is ready.\n`,
        );
        return 1;
      }

      const latest = loadRuntimeState(statePath, runId);
      launchArgs = buildResumeArgs(opts.originalArgs, latest, false);
      launchArgs = injectRuntimeSettings(launchArgs, runId, statePath, settingsPath, writeSettingsFile);

      process.stderr.write(`[ccswap] Switching to '${nextName}'\n`);
      state.active_account = nextName;
      saveState(state);
      currentName = nextName;
    }
  } finally {
    for (const path of [statePath, settingsPath]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    }
  }
}
