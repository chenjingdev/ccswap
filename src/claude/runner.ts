import type { IPty } from "node-pty";
import * as nodePty from "node-pty";

import { detectClaudeAuthFailure, type ClaudeAuthFailure } from "./auth-failure.js";
import { LimitDetector } from "./limit-detector.js";
import { preparePty } from "./pty-prep.js";

export interface RunnerOptions {
  claudeBin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  accountName: string;
  onStarted?: (pid: number) => void;
  shouldArmLimit?: () => boolean;
  shouldConfirmLimit?: () => Promise<boolean> | boolean;
  shouldProactivelySwap?: () => Promise<boolean> | boolean;
  shouldApplyRequestedAccount?: () => Promise<boolean> | boolean;
  onProactiveSwap?: () => Promise<boolean> | boolean;
  onProactiveSwapPending?: () => void;
  onProactiveSwapBoundary?: () => void;
  onRequestedAccountPending?: () => void;
  onRequestedAccountBoundary?: () => void;
  onAuthFailure?: (failure: ClaudeAuthFailure) => void;
  canExitPendingSwap?: () => boolean;
  shouldReplayProactiveSwap?: () => boolean;
  shouldReplayRequestedAccountSwap?: () => boolean;
  proactiveQuietMs?: number;
  proactiveMaxWaitMs?: number;
}

export interface RunnerResult {
  exitCode: number;
  limitHit: boolean;
  proactiveSwap: boolean;
  proactiveSwapNeedsPrompt: boolean;
  requestedAccountSwap: boolean;
  requestedAccountSwapNeedsPrompt: boolean;
  authFailure: ClaudeAuthFailure | null;
}

const GRACEFUL_EXIT_PAYLOADS = ["\x03", "\x1b", "1\n", "/exit\n", "exit\n"];
const LIMIT_GRACE_MS = 1000;
const LIMIT_TERM_DELAY_MS = 1000;
const LIMIT_KILL_DELAY_MS = 2500;
const PROACTIVE_QUIET_MS = 1500;
function getWinsize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

export async function runClaude(opts: RunnerOptions): Promise<RunnerResult> {
  preparePty();
  const { cols, rows } = getWinsize();
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;

  const pty: IPty = nodePty.spawn(opts.claudeBin, opts.args, {
    name: process.env["TERM"] ?? "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: opts.env as { [key: string]: string },
    useConpty: true,
  });

  opts.onStarted?.(pty.pid);

  const detector = new LimitDetector();
  let limitDetectedAt: number | null = null;
  let limitExitRequested = false;
  let limitTermScheduled = false;
  let limitKillScheduled = false;
  let limitConfirmed = false;
  let proactiveSwapRequested = false;
  let proactiveSwapNeedsPrompt = false;
  let proactiveCheckInFlight = false;
  let proactivePending = false;
  let proactivePendingAt: number | null = null;
  let requestedAccountSwapRequested = false;
  let requestedAccountSwapNeedsPrompt = false;
  let requestedAccountCheckInFlight = false;
  let requestedAccountPending = false;
  let requestedAccountPendingAt: number | null = null;
  let authFailure: ClaudeAuthFailure | null = null;
  let lastActivityAt = Date.now();
  const proactiveQuietMs = Math.max(0, opts.proactiveQuietMs ?? PROACTIVE_QUIET_MS);
  const proactiveMaxWaitMs = opts.proactiveMaxWaitMs === undefined
    ? null
    : Math.max(0, opts.proactiveMaxWaitMs);

  const armed = (): boolean => (opts.shouldArmLimit ? opts.shouldArmLimit() : true);
  const requestedAccountAvailable = async (): Promise<boolean> => {
    if (!opts.shouldApplyRequestedAccount) return false;
    return Boolean(await opts.shouldApplyRequestedAccount());
  };
  const markActivity = (): void => {
    lastActivityAt = Date.now();
  };

  const onDataSub = pty.onData((chunk: string) => {
    markActivity();
    stdout.write(chunk);
    if (!authFailure) {
      const detected = detectClaudeAuthFailure(chunk);
      if (detected) {
        authFailure = detected;
        try {
          opts.onAuthFailure?.(detected);
        } catch {
          // Auth-state reporting must not block the user's Claude session.
        }
      }
    }
    if (armed()) detector.feed(chunk);
  });

  const onStdin = (chunk: Buffer | string): void => {
    markActivity();
    try {
      pty.write(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
    } catch {
      // ignore writes after pty exited
    }
  };
  const onResize = (): void => {
    const size = getWinsize();
    try {
      pty.resize(size.cols, size.rows);
    } catch {
      // ignore
    }
  };

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onStdin);
  stdout.on("resize", onResize);

  const limitPoll = setInterval(() => {
    void processLimitTick();
  }, 200);

  const proactivePoll = setInterval(() => {
    void processProactiveTick();
  }, 2_000);

  const requestedAccountPoll = setInterval(() => {
    void processRequestedAccountTick();
  }, 500);

  const announceSwitch = (): void => {
    process.stderr.write("\r\n[ccswap] Claude limit detected. Rotating to the next account...\r\n");
  };

  const tryGracefulExit = (): void => {
    for (const payload of GRACEFUL_EXIT_PAYLOADS) {
      try {
        pty.write(payload);
      } catch {
        break;
      }
    }
  };

  const requestProactiveExit = (): void => {
    if (limitExitRequested || proactiveSwapRequested || requestedAccountSwapRequested) return;
    proactiveSwapRequested = true;
    try {
      opts.onProactiveSwapBoundary?.();
    } catch {
      // Runtime-state reporting must not block the actual relaunch.
    }
    process.stderr.write("\r\n[ccswap] Usage threshold reached. Restarting Claude at a quiet boundary...\r\n");
    tryGracefulExit();
    setTimeout(() => {
      try {
        pty.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, LIMIT_TERM_DELAY_MS);
    setTimeout(() => {
      try {
        pty.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, LIMIT_KILL_DELAY_MS);
  };

  const requestRequestedAccountExit = (): void => {
    if (limitExitRequested || proactiveSwapRequested || requestedAccountSwapRequested) return;
    requestedAccountSwapRequested = true;
    try {
      opts.onRequestedAccountBoundary?.();
    } catch {
      // Runtime-state reporting must not block the actual relaunch.
    }
    process.stderr.write("\r\n[ccswap] Account switch requested. Restarting Claude at a quiet boundary...\r\n");
    tryGracefulExit();
    setTimeout(() => {
      try {
        pty.kill("SIGTERM");
      } catch {
        // ignore
      }
    }, LIMIT_TERM_DELAY_MS);
    setTimeout(() => {
      try {
        pty.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, LIMIT_KILL_DELAY_MS);
  };

  const maybeExitAtProactiveBoundary = (now = Date.now()): void => {
    if (!proactivePending || proactivePendingAt === null || limitExitRequested || proactiveSwapRequested || requestedAccountSwapRequested) return;
    const quietForMs = now - lastActivityAt;
    const pendingForMs = now - proactivePendingAt;
    const quiet = quietForMs >= proactiveQuietMs;
    const forced = proactiveMaxWaitMs !== null && pendingForMs >= proactiveMaxWaitMs;
    const safe = forced || opts.canExitPendingSwap?.() !== false;
    if ((quiet && safe) || forced) {
      proactiveSwapNeedsPrompt = proactiveSwapNeedsPrompt || (forced && !quiet);
      requestProactiveExit();
    }
  };

  const maybeExitAtRequestedAccountBoundary = (now = Date.now()): void => {
    if (
      !requestedAccountPending ||
      requestedAccountPendingAt === null ||
      limitExitRequested ||
      proactiveSwapRequested ||
      requestedAccountSwapRequested
    ) {
      return;
    }
    const quietForMs = now - lastActivityAt;
    const pendingForMs = now - requestedAccountPendingAt;
    const quiet = quietForMs >= proactiveQuietMs;
    const forced = proactiveMaxWaitMs !== null && pendingForMs >= proactiveMaxWaitMs;
    const safe = forced || opts.canExitPendingSwap?.() !== false;
    if ((quiet && safe) || forced) {
      requestedAccountSwapNeedsPrompt = Boolean(opts.shouldReplayRequestedAccountSwap?.()) || (forced && !quiet);
      requestRequestedAccountExit();
    }
  };

  async function processProactiveTick(): Promise<void> {
    if (
      !opts.shouldProactivelySwap ||
      limitExitRequested ||
      proactiveSwapRequested ||
      requestedAccountSwapRequested ||
      requestedAccountPending ||
      proactiveCheckInFlight
    ) {
      return;
    }
    proactiveCheckInFlight = true;
    try {
      if (proactivePending) {
        if (await requestedAccountAvailable()) {
          proactivePending = false;
          proactivePendingAt = null;
          proactiveSwapNeedsPrompt = false;
          return;
        }
        maybeExitAtProactiveBoundary();
        return;
      }
      if (await requestedAccountAvailable()) return;
      const shouldSwap = await opts.shouldProactivelySwap();
      if (!shouldSwap || limitExitRequested || proactiveSwapRequested || requestedAccountSwapRequested) return;
      if (await requestedAccountAvailable()) return;
      if (opts.onProactiveSwap) {
        const handled = await opts.onProactiveSwap();
        if (handled) return;
      }
      if (limitExitRequested || proactiveSwapRequested || requestedAccountSwapRequested) return;
      proactivePending = true;
      proactivePendingAt = Date.now();
      proactiveSwapNeedsPrompt = Boolean(opts.shouldReplayProactiveSwap?.());
      try {
        opts.onProactiveSwapPending?.();
      } catch {
        // Runtime-state reporting must not block the actual relaunch.
      }
      maybeExitAtProactiveBoundary();
    } catch {
      // Proactive swapping is best-effort; limit detection remains the hard stop.
    } finally {
      proactiveCheckInFlight = false;
    }
  }

  async function processRequestedAccountTick(): Promise<void> {
    if (
      !opts.shouldApplyRequestedAccount ||
      limitExitRequested ||
      proactiveSwapRequested ||
      requestedAccountSwapRequested ||
      requestedAccountCheckInFlight
    ) {
      return;
    }
    requestedAccountCheckInFlight = true;
    try {
      if (requestedAccountPending) {
        maybeExitAtRequestedAccountBoundary();
        return;
      }
      const shouldSwap = await opts.shouldApplyRequestedAccount();
      if (!shouldSwap || limitExitRequested || proactiveSwapRequested || requestedAccountSwapRequested) return;
      proactivePending = false;
      proactivePendingAt = null;
      proactiveSwapNeedsPrompt = false;
      requestedAccountPending = true;
      requestedAccountPendingAt = Date.now();
      requestedAccountSwapNeedsPrompt = Boolean(opts.shouldReplayRequestedAccountSwap?.());
      try {
        opts.onRequestedAccountPending?.();
      } catch {
        // Runtime-state reporting must not block the actual relaunch.
      }
      maybeExitAtRequestedAccountBoundary();
    } catch {
      // Manual session switching is best-effort; hard limit handling remains authoritative.
    } finally {
      requestedAccountCheckInFlight = false;
    }
  }

  let confirming = false;
  async function processLimitTick(): Promise<void> {
    if (!detector.matched) return;
    if (limitDetectedAt === null) {
      limitDetectedAt = Date.now();
      return;
    }
    const elapsed = Date.now() - limitDetectedAt;

    if (!limitExitRequested && elapsed >= LIMIT_GRACE_MS && !confirming) {
      confirming = true;
      let ok = true;
      try {
        const confirm = opts.shouldConfirmLimit;
        if (confirm) {
          const res = await confirm();
          ok = Boolean(res);
        }
      } catch {
        ok = true;
      }
      confirming = false;
      if (!ok) {
        detector.reset();
        limitDetectedAt = null;
        return;
      }
      limitConfirmed = true;
      limitExitRequested = true;
      announceSwitch();
      tryGracefulExit();
      return;
    }

    if (limitExitRequested && !limitTermScheduled && elapsed >= LIMIT_GRACE_MS + LIMIT_TERM_DELAY_MS) {
      limitTermScheduled = true;
      try {
        pty.kill("SIGTERM");
      } catch {
        // ignore
      }
    }

    if (limitExitRequested && !limitKillScheduled && elapsed >= LIMIT_GRACE_MS + LIMIT_KILL_DELAY_MS) {
      limitKillScheduled = true;
      try {
        pty.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  return await new Promise<RunnerResult>((resolve) => {
    pty.onExit(({ exitCode }) => {
      clearInterval(limitPoll);
      clearInterval(proactivePoll);
      clearInterval(requestedAccountPoll);
      onDataSub.dispose();
      stdin.off("data", onStdin);
      stdout.off("resize", onResize);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve({
        exitCode: exitCode ?? 0,
        limitHit: limitConfirmed,
        proactiveSwap: proactiveSwapRequested,
        proactiveSwapNeedsPrompt,
        requestedAccountSwap: requestedAccountSwapRequested,
        requestedAccountSwapNeedsPrompt,
        authFailure,
      });
    });
  });
}
