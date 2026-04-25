import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import type { AccountData, AppConfigData } from "../core/config.js";
import type { AppStateData } from "../core/state.js";
import { ensureDir } from "../core/fs-util.js";
import { RUNTIME_DIR } from "../core/paths.js";
import { saveState } from "../core/state.js";
import {
  withUsageCaptureSettingsArgs,
  writeUsageCaptureSettings,
} from "../core/statusline.js";
import {
  activateAccountCredential,
  getAccountCredential,
} from "../core/credentials.js";
import { buildClaudeEnv } from "../core/env.js";
import { isAccountUsageAtOrAbove, isAccountUsageExhausted } from "../core/usage.js";
import {
  cleanupStaleRuntimeSessions,
  loadRuntimeState,
  runtimeStatePath,
  saveRuntimeState,
  updateRuntimeState,
  type SessionRuntimeState,
} from "../core/runtime.js";
import { buildResumeArgs, resolveSessionDirective, splitPromptFromArgs } from "./args.js";
import { runClaude } from "./runner.js";
import { startSessionWatcher, type SessionWatcherHandle } from "./session-watcher.js";

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

async function pickNextReadyAccount(
  accounts: AccountData[],
  state: AppStateData,
  exclude: Set<string>,
  proactiveThresholdPct: number | null,
): Promise<string | null> {
  const skipped = new Set(exclude);
  while (true) {
    const next = pickNextAccount(accounts, state, skipped);
    if (!next) return null;
    if (proactiveThresholdPct === null) return next;
    const account = accounts.find((a) => a.name === next);
    if (!account) return null;
    if (!(await isAccountUsageAtOrAbove(account, proactiveThresholdPct, false))) {
      return next;
    }
    skipped.add(next);
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
  const settingsPath = `${statePath.slice(0, -".json".length)}.settings.json`;
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

  // Pre-resolve the session id so the watcher can pin the run to a specific
  // Claude transcript instead of guessing from cwd+mtime. If the user did not
  // already pass --session-id / --resume / -c, ccswap generates a fresh UUID
  // and injects --session-id so Claude persists to a filename we chose.
  const initialDirective = resolveSessionDirective(opts.originalArgs);
  let launchArgs = [...opts.originalArgs];
  let expectedSessionId: string | null = null;
  if (initialDirective.kind === "user-provided") {
    expectedSessionId = initialDirective.sessionId;
  } else if (initialDirective.kind === "none") {
    expectedSessionId = randomUUID();
    launchArgs.push("--session-id", expectedSessionId);
  }
  // For "user-continue" we leave expectedSessionId null and rely on the
  // watcher's mtime-snapshot fallback — Claude picks which file to resume.

  if (expectedSessionId) {
    updateRuntimeState(statePath, runId, { session_id: expectedSessionId });
  }

  let watcher: SessionWatcherHandle | null = null;
  const stopWatcher = (): void => {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
  };

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

      stopWatcher();
      watcher = startSessionWatcher({
        runId,
        statePath,
        launchCwd: opts.launchCwd,
        launchedAtMs: Date.now(),
        expectedSessionId,
      });

      writeUsageCaptureSettings(account, settingsPath, launchArgs);
      const runArgs = withUsageCaptureSettingsArgs(launchArgs, settingsPath);

      const result = await runClaude({
        claudeBin: config.claude_bin,
        args: runArgs,
        cwd: opts.launchCwd,
        env: buildClaudeEnv(),
        accountName: account.name,
        onStarted: (pid) => {
          updateRuntimeState(statePath, runId, {
            claude_pid: pid,
            active_account: account.name,
          });
        },
        shouldArmLimit: () => loadRuntimeState(statePath, runId).detector_armed,
        shouldConfirmLimit: () => isAccountUsageExhausted(account, true),
        shouldProactivelySwap: config.proactive_swap_threshold_pct === null
          ? undefined
          : () => isAccountUsageAtOrAbove(account, config.proactive_swap_threshold_pct ?? 95, false),
      });

      stopWatcher();

      if (!result.limitHit && !result.proactiveSwap) {
        return result.exitCode;
      }

      attempted.add(account.name);

      const nextName = await pickNextReadyAccount(
        eligible,
        state,
        attempted,
        config.proactive_swap_threshold_pct,
      );
      if (!nextName) {
        const reason = result.proactiveSwap ? "reached the proactive swap threshold" : "hit its limit";
        process.stderr.write(`[ccswap] '${account.name}' ${reason} and no backup account is ready.\n`);
        return 1;
      }

      const latest = loadRuntimeState(statePath, runId);
      launchArgs = buildResumeArgs(
        opts.originalArgs,
        result.proactiveSwap
          ? { ...latest, replay_mode: "continue", last_prompt: null, custom_prompt: null }
          : latest,
        false,
      );
      // Re-derive the expected session id from the rebuilt args. buildResumeArgs
      // prepends `--resume <sessionId>`, which resolveSessionDirective reports
      // as user-provided — so the watcher on the next iteration stays pinned
      // to the exact same transcript we were tracking before the swap.
      const nextDirective = resolveSessionDirective(launchArgs);
      if (nextDirective.kind === "user-provided") {
        expectedSessionId = nextDirective.sessionId;
      }
      // If the swap could not resolve a session id (e.g. watcher had not yet
      // discovered one for a --continue run), leave the previous value in
      // place; a null expectedSessionId will re-enter the mtime-snapshot path.

      process.stderr.write(`[ccswap] Switching to '${nextName}'\n`);
      state.active_account = nextName;
      saveState(state);
      currentName = nextName;
    }
  } finally {
    stopWatcher();
    for (const path of [statePath, settingsPath]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    }
  }
}
