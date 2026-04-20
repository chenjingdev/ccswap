import type { IPty } from "node-pty";
import * as nodePty from "node-pty";

import { RESUME_HINT_PATTERN } from "../core/constants.js";
import { LimitDetector } from "./limit-detector.js";
import { preparePty } from "./pty-prep.js";

export interface RunnerOptions {
  claudeBin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  accountName: string;
  onStarted?: (pid: number) => void;
  onSessionHint?: (sessionId: string) => void;
  shouldArmLimit?: () => boolean;
  shouldConfirmLimit?: () => Promise<boolean> | boolean;
}

export interface RunnerResult {
  exitCode: number;
  limitHit: boolean;
}

const GRACEFUL_EXIT_PAYLOADS = ["\x03", "\x1b", "1\n", "/exit\n", "exit\n"];
const LIMIT_GRACE_MS = 1000;
const LIMIT_TERM_DELAY_MS = 1000;
const LIMIT_KILL_DELAY_MS = 2500;

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
  let hintBuffer = "";
  let limitDetectedAt: number | null = null;
  let limitExitRequested = false;
  let limitTermScheduled = false;
  let limitKillScheduled = false;
  let limitConfirmed = false;

  const armed = (): boolean => (opts.shouldArmLimit ? opts.shouldArmLimit() : true);

  const onDataSub = pty.onData((chunk: string) => {
    stdout.write(chunk);
    if (armed()) detector.feed(chunk);
    hintBuffer = (hintBuffer + chunk).slice(-8000);
    const matches = [...hintBuffer.matchAll(RESUME_HINT_PATTERN)];
    if (matches.length > 0 && opts.onSessionHint) {
      const last = matches[matches.length - 1];
      const sessionId = last?.[1];
      if (sessionId) opts.onSessionHint(sessionId);
    }
  });

  const onStdin = (chunk: Buffer | string): void => {
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
      onDataSub.dispose();
      stdin.off("data", onStdin);
      stdout.off("resize", onResize);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve({ exitCode: exitCode ?? 0, limitHit: limitConfirmed });
    });
  });
}
