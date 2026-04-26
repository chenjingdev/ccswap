import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import { loadConfig, type AccountData, type AppConfigData } from "../core/config.js";
import { accountNeedsRelogin, markAccountAuthError } from "../core/accounts.js";
import type { AppStateData } from "../core/state.js";
import { ensureDir } from "../core/fs-util.js";
import { CONFIG_PATH, RUNTIME_DIR } from "../core/paths.js";
import {
  withUsageCaptureSettingsArgs,
  writeUsageCaptureSettings,
} from "../core/statusline.js";
import { getAccountCredential } from "../core/credentials.js";
import { buildClaudeLaunchAuth } from "../core/env.js";
import {
  getAccountUsageThresholdStatus,
  isAccountUsageAtOrAbove,
  isAccountUsageExhausted,
  refreshAccountUsage,
} from "../core/usage.js";
import {
  cleanupStaleRuntimeSessions,
  loadRuntimeState,
  runtimeStatePath,
  saveRuntimeState,
  updateRuntimeState,
  type SessionRuntimeState,
} from "../core/runtime.js";
import { buildResumeArgs, resolveSessionDirective, splitPromptFromArgs } from "./args.js";
import { runClaude, type RunnerResult } from "./runner.js";
import { startSessionWatcher, type SessionWatcherHandle } from "./session-watcher.js";

const USAGE_RESET_RECHECK_BUFFER_MS = 1000;
const USAGE_RESET_UNKNOWN_RECHECK_MS = 5 * 60_000;

function pickLaunchAccount(accounts: AccountData[], state: AppStateData): string | null {
  if (accounts.length === 0) return null;
  const pivot = state.default_account ?? state.last_default_account;
  if (pivot) {
    const hit = accounts.find((a) => a.name === pivot);
    if (hit) return hit.name;
  }
  return accounts[0]?.name ?? null;
}

function pickNextAccount(
  accounts: AccountData[],
  pivot: string | null,
  exclude: Set<string>,
): string | null {
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
  pivot: string | null,
  exclude: Set<string>,
  proactiveThresholdPct: number | null,
): Promise<string | null> {
  const skipped = new Set(exclude);
  while (true) {
    const next = pickNextAccount(accounts, pivot, skipped);
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

function getRequestedAccount(
  runtime: SessionRuntimeState,
  accounts: AccountData[],
  currentName: string,
): string | null {
  if (!runtime.requested_account || runtime.requested_account === currentName) return null;
  const requested = accounts.find((account) => account.name === runtime.requested_account);
  return requested ? requested.name : null;
}

function configuredAccounts(fallback: AccountData[]): AccountData[] {
  try {
    return existsSync(CONFIG_PATH) ? loadConfig().accounts : fallback;
  } catch {
    return fallback;
  }
}

function configuredProactiveThreshold(fallback: number | null): number | null {
  try {
    return existsSync(CONFIG_PATH) ? loadConfig().proactive_swap_threshold_pct : fallback;
  } catch {
    return fallback;
  }
}

function eligibleAccounts(fallback: AccountData[]): AccountData[] {
  return configuredAccounts(fallback).filter((a) => getAccountCredential(a) !== null && !accountNeedsRelogin(a));
}

function reloginBlockedAccounts(fallback: AccountData[]): AccountData[] {
  return configuredAccounts(fallback).filter((a) => getAccountCredential(a) !== null && accountNeedsRelogin(a));
}

function writeNoEligibleAccountsMessage(fallback: AccountData[]): void {
  const blocked = reloginBlockedAccounts(fallback);
  if (blocked.length > 0) {
    const first = blocked[0]!;
    process.stderr.write(
      `[ccswap] Saved Claude login for '${first.name}' needs re-login. Run: ccswap login ${first.name}\n`,
    );
    if (blocked.length > 1) {
      process.stderr.write(`[ccswap] ${blocked.length - 1} more saved login(s) also need re-login.\n`);
    }
    return;
  }
  process.stderr.write("[ccswap] No accounts with saved logins configured.\n");
}

function timestampMs(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function proactiveWaitIsActive(runtime: SessionRuntimeState, nowMs = Date.now()): boolean {
  if (runtime.swap_wait_reason !== "usage_reset") return false;
  const waitUntil = timestampMs(runtime.swap_wait_until);
  return waitUntil > nowMs;
}

function usageResetRecheckAt(accounts: AccountData[], threshold: number, nowMs = Date.now()): string {
  let resetMs: number | null = null;
  for (const account of accounts) {
    const status = getAccountUsageThresholdStatus(account, threshold);
    if (!status.atOrAbove || status.fiveHourResetMs === null) continue;
    resetMs = resetMs === null ? status.fiveHourResetMs : Math.min(resetMs, status.fiveHourResetMs);
  }
  const nextMs = resetMs === null
    ? nowMs + USAGE_RESET_UNKNOWN_RECHECK_MS
    : Math.max(nowMs + USAGE_RESET_RECHECK_BUFFER_MS, resetMs + USAGE_RESET_RECHECK_BUFFER_MS);
  return new Date(nextMs).toISOString();
}

function setUsageResetWait(statePath: string, runId: string, until: string): void {
  const latest = loadRuntimeState(statePath, runId);
  if (latest.swap_wait_reason === "usage_reset" && latest.swap_wait_until === until) return;
  updateRuntimeState(statePath, runId, {
    swap_pending: false,
    swap_reason: null,
    swap_requested_at: null,
    swap_wait_until: until,
    swap_wait_reason: "usage_reset",
    last_activity_at: new Date().toISOString(),
    safe_to_restart: false,
  });
}

function clearUsageResetWait(statePath: string, runId: string): void {
  const latest = loadRuntimeState(statePath, runId);
  if (latest.swap_wait_until === null && latest.swap_wait_reason === null) return;
  updateRuntimeState(statePath, runId, {
    swap_wait_until: null,
    swap_wait_reason: null,
  });
}

async function refreshUsageForAccounts(accounts: AccountData[]): Promise<void> {
  await Promise.all(accounts.map(async (account) => {
    try {
      await refreshAccountUsage(account, true);
    } catch {
      // Usage refresh should not interrupt the running Claude session.
    }
  }));
}

function runtimeTurnIsComplete(runtime: SessionRuntimeState): boolean {
  const promptAt = timestampMs(runtime.last_prompt_at);
  if (promptAt <= 0) return true;
  return timestampMs(runtime.last_assistant_stop_at ?? null) >= promptAt;
}

function runtimeTurnWasIncompleteAt(runtime: SessionRuntimeState, markerIso: string | null): boolean {
  const markerAt = timestampMs(markerIso);
  const promptAt = timestampMs(runtime.last_prompt_at);
  if (markerAt <= 0 || promptAt <= 0 || markerAt < promptAt) return false;
  const stopAt = timestampMs(runtime.last_assistant_stop_at ?? null);
  return stopAt <= 0 || markerAt < stopAt;
}

function requestedSwitchNeedsReplayPrompt(runtime: SessionRuntimeState): boolean {
  return runtimeTurnWasIncompleteAt(runtime, runtime.requested_at);
}

function runtimeHasConversation(runtime: SessionRuntimeState): boolean {
  return Boolean(runtime.session_id && runtime.last_prompt_at);
}

interface PreparedLaunchArgs {
  args: string[];
  expectedSessionId: string | null;
  runtimeSessionId: string | null;
}

function prepareLaunchArgs(args: string[]): PreparedLaunchArgs {
  const directive = resolveSessionDirective(args);
  if (directive.kind === "user-provided") {
    return {
      args: [...args],
      expectedSessionId: directive.sessionId,
      runtimeSessionId: directive.sessionId,
    };
  }
  if (directive.kind === "none") {
    const launchPrompt = splitPromptFromArgs(args).prompt;
    const shouldExposeGeneratedSession =
      Boolean(launchPrompt) && !launchPrompt?.trimStart().startsWith("/");
    if (!shouldExposeGeneratedSession) {
      return {
        args: [...args],
        expectedSessionId: null,
        runtimeSessionId: null,
      };
    }
    const sessionId = randomUUID();
    return {
      args: [...args, "--session-id", sessionId],
      expectedSessionId: sessionId,
      runtimeSessionId: sessionId,
    };
  }
  return {
    args: [...args],
    expectedSessionId: null,
    runtimeSessionId: null,
  };
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

  let eligible = eligibleAccounts(config.accounts);
  if (eligible.length === 0) {
    writeNoEligibleAccountsMessage(config.accounts);
    return 1;
  }

  let currentName = pickLaunchAccount(eligible, state);
  if (!currentName) {
    process.stderr.write("[ccswap] No eligible account is available.\n");
    return 1;
  }
  const launchThreshold = configuredProactiveThreshold(config.proactive_swap_threshold_pct);
  const launchAccount = eligible.find((a) => a.name === currentName);
  if (
    launchAccount &&
    launchThreshold !== null &&
    await isAccountUsageAtOrAbove(launchAccount, launchThreshold, false)
  ) {
    currentName = await pickNextReadyAccount(eligible, currentName, new Set([currentName]), launchThreshold)
      ?? currentName;
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
    last_assistant_stop_at: null,
    detector_armed: false,
    cwd: opts.launchCwd,
    active_account: currentName,
    replay_mode: config.replay_mode,
    custom_prompt: config.custom_prompt || null,
    started_at: new Date().toISOString(),
    ccswap_pid: process.pid,
    claude_pid: null,
    swap_pending: false,
    swap_reason: null,
    swap_requested_at: null,
    swap_wait_until: null,
    swap_wait_reason: null,
    requested_account: null,
    requested_reason: null,
    requested_at: null,
    last_activity_at: null,
    safe_to_restart: false,
    auth_error_account: null,
    auth_error_reason: null,
    auth_error_at: null,
  };
  saveRuntimeState(statePath, runtime);

  // Generated --session-id values are only anchors for the watcher. They are
  // not safe to replay until Claude actually creates the transcript file.
  // User-provided --resume/--session-id values are already real user intent, so
  // those can be exposed immediately in runtime state.
  let preparedLaunch = prepareLaunchArgs(opts.originalArgs);
  let launchArgs = preparedLaunch.args;
  let expectedSessionId = preparedLaunch.expectedSessionId;
  let runtimeSessionId = preparedLaunch.runtimeSessionId;

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
      eligible = eligibleAccounts(config.accounts);
      const account = eligible.find((a) => a.name === currentName);
      if (!account) {
        process.stderr.write(`[ccswap] Missing account '${currentName}'.\n`);
        return 1;
      }

      const { prompt: launchPrompt } = splitPromptFromArgs(launchArgs);
      const detectorArmed = Boolean(launchPrompt && !launchPrompt.trimStart().startsWith("/"));
      const launchedTurnAt = detectorArmed ? new Date().toISOString() : null;

      updateRuntimeState(statePath, runId, {
        cwd: opts.launchCwd,
        active_account: account.name,
        session_id: runtimeSessionId,
        ccswap_pid: process.pid,
        detector_armed: detectorArmed,
        last_prompt: detectorArmed ? launchPrompt : null,
        last_prompt_at: launchedTurnAt,
        last_assistant_stop_at: null,
        swap_pending: false,
        swap_reason: null,
        swap_requested_at: null,
        swap_wait_until: null,
        swap_wait_reason: null,
        last_activity_at: null,
        safe_to_restart: false,
      });

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

      const auth = buildClaudeLaunchAuth(account, config.auth_mode);
      if (auth.error) {
        process.stderr.write(auth.error);
        return 1;
      }
      const env = auth.env;

      let result: RunnerResult;
      result = await runClaude({
        claudeBin: config.claude_bin,
        args: runArgs,
        cwd: opts.launchCwd,
        env,
        accountName: account.name,
        onStarted: (pid) => {
          updateRuntimeState(statePath, runId, {
            claude_pid: pid,
            active_account: account.name,
          });
        },
        shouldArmLimit: () => loadRuntimeState(statePath, runId).detector_armed,
        shouldConfirmLimit: () => isAccountUsageExhausted(account, true),
        shouldApplyRequestedAccount: () => {
          const latest = loadRuntimeState(statePath, runId);
          if (!latest.requested_account) return false;
          return getRequestedAccount(latest, eligibleAccounts(config.accounts), account.name) !== null;
        },
        shouldProactivelySwap: async () => {
          const latest = loadRuntimeState(statePath, runId);
          if (!runtimeHasConversation(latest)) return false;
          const threshold = configuredProactiveThreshold(config.proactive_swap_threshold_pct);
          if (threshold === null) {
            clearUsageResetWait(statePath, runId);
            return false;
          }

          const latestEligible = eligibleAccounts(config.accounts);
          const waitingForReset = latest.swap_wait_reason === "usage_reset";
          const waitStillActive = proactiveWaitIsActive(latest);
          if (waitingForReset && !waitStillActive) {
            await refreshUsageForAccounts(latestEligible);
          }

          const currentReachedThreshold = await isAccountUsageAtOrAbove(account, threshold, false);
          if (!currentReachedThreshold) {
            clearUsageResetWait(statePath, runId);
            return false;
          }

          const nextReady = await pickNextReadyAccount(latestEligible, account.name, new Set([account.name]), threshold);
          if (nextReady) {
            clearUsageResetWait(statePath, runId);
            return true;
          }
          if (waitStillActive) return false;

          const waitAccounts = latestEligible.length > 0 ? latestEligible : [account];
          setUsageResetWait(statePath, runId, usageResetRecheckAt(waitAccounts, threshold));
          return false;
        },
        canExitPendingSwap: () => runtimeTurnIsComplete(loadRuntimeState(statePath, runId)),
        shouldReplayProactiveSwap: () => !runtimeTurnIsComplete(loadRuntimeState(statePath, runId)),
        shouldReplayRequestedAccountSwap: () => requestedSwitchNeedsReplayPrompt(loadRuntimeState(statePath, runId)),
        onProactiveSwapPending: () => {
          const now = new Date().toISOString();
          updateRuntimeState(statePath, runId, {
            swap_pending: true,
            swap_reason: "proactive_usage",
            swap_requested_at: now,
            swap_wait_until: null,
            swap_wait_reason: null,
            last_activity_at: now,
            safe_to_restart: false,
          });
        },
        onProactiveSwapBoundary: () => {
          updateRuntimeState(statePath, runId, {
            safe_to_restart: true,
            last_activity_at: new Date().toISOString(),
          });
        },
        onRequestedAccountPending: () => {
          updateRuntimeState(statePath, runId, {
            swap_pending: false,
            swap_reason: null,
            swap_requested_at: null,
            swap_wait_until: null,
            swap_wait_reason: null,
            last_activity_at: new Date().toISOString(),
            safe_to_restart: false,
          });
        },
        onRequestedAccountBoundary: () => {
          updateRuntimeState(statePath, runId, {
            safe_to_restart: true,
            last_activity_at: new Date().toISOString(),
          });
        },
        onAuthFailure: (failure) => {
          updateRuntimeState(statePath, runId, {
            auth_error_account: account.name,
            auth_error_reason: failure.reason,
            auth_error_at: new Date().toISOString(),
            safe_to_restart: false,
          });
        },
      });

      stopWatcher();

      if (result.authFailure) {
        const reason = result.authFailure.reason;
        markAccountAuthError(account.name, reason);
        process.stderr.write(
          `[ccswap] Claude login for '${account.name}' looks expired or invalid (${reason}). Run: ccswap login ${account.name}\n`,
        );
        return result.exitCode || 1;
      }

      if (!result.limitHit && !result.proactiveSwap && !result.requestedAccountSwap) {
        return result.exitCode;
      }

      const endedAccountName = account.name;
      let nextName: string | null = null;
      const latest = loadRuntimeState(statePath, runId);
      eligible = eligibleAccounts(config.accounts);
      const requestedNextName = getRequestedAccount(latest, eligible, endedAccountName);

      if (result.requestedAccountSwap) {
        nextName = requestedNextName;
        if (!nextName) {
          updateRuntimeState(statePath, runId, {
            requested_account: null,
            requested_reason: null,
            requested_at: null,
            safe_to_restart: false,
          });
          return result.exitCode;
        }
      } else if (requestedNextName) {
        nextName = requestedNextName;
      } else {
        attempted.add(endedAccountName);
        nextName = await pickNextReadyAccount(
          eligible,
          endedAccountName,
          attempted,
          configuredProactiveThreshold(config.proactive_swap_threshold_pct),
        );
      }

      if (!nextName) {
        const reason = result.proactiveSwap ? "reached the proactive swap threshold" : "hit its limit";
        process.stderr.write(`[ccswap] '${endedAccountName}' ${reason} and no backup account is ready.\n`);
        return 1;
      }

      const includeReplayPrompt =
        result.limitHit ||
        (result.proactiveSwap && result.proactiveSwapNeedsPrompt) ||
        (result.requestedAccountSwap && result.requestedAccountSwapNeedsPrompt) ||
        (!result.requestedAccountSwap && requestedNextName !== null && requestedSwitchNeedsReplayPrompt(latest));
      const resumeRuntime =
        result.proactiveSwap && requestedNextName === null
          ? { ...latest, replay_mode: "continue", last_prompt: null, custom_prompt: null }
          : latest;
      launchArgs = buildResumeArgs(
        opts.originalArgs,
        resumeRuntime,
        false,
        includeReplayPrompt,
      );
      preparedLaunch = prepareLaunchArgs(launchArgs);
      launchArgs = preparedLaunch.args;
      expectedSessionId = preparedLaunch.expectedSessionId;
      runtimeSessionId = preparedLaunch.runtimeSessionId;

      updateRuntimeState(statePath, runId, {
        session_id: runtimeSessionId,
        requested_account: null,
        requested_reason: null,
        requested_at: null,
        swap_wait_until: null,
        swap_wait_reason: null,
        safe_to_restart: false,
      });
      process.stderr.write(`[ccswap] Switching this session to '${nextName}'\n`);
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
