import type { IPty } from "node-pty";
import * as nodePty from "node-pty";

import { preparePty } from "./pty-prep.js";

export interface InteractiveResult {
  exitCode: number;
  signal: number | null;
  output: string;
}

export interface InteractiveOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  title?: string;
  onData?: (chunk: string) => void;
}

function getWinsize(): { cols: number; rows: number } {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return { cols, rows };
}

export async function runInteractive(opts: InteractiveOptions): Promise<InteractiveResult> {
  preparePty();
  const { cols, rows } = getWinsize();
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;

  if (opts.title) {
    stdout.write(`[ccswap] ${opts.title}\r\n`);
  }

  const pty: IPty = nodePty.spawn(opts.cmd, opts.args, {
    name: process.env["TERM"] ?? "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: opts.env as { [key: string]: string },
    useConpty: true,
  });

  const captured: string[] = [];
  const onDataSub = pty.onData((chunk: string) => {
    stdout.write(chunk);
    captured.push(chunk);
    opts.onData?.(chunk);
  });

  const onStdin = (chunk: Buffer | string): void => {
    pty.write(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
  };
  const onResize = (): void => {
    const size = getWinsize();
    try {
      pty.resize(size.cols, size.rows);
    } catch {
      // ignore
    }
  };

  if (stdin.isTTY) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on("data", onStdin);
  stdout.on("resize", onResize);

  return await new Promise<InteractiveResult>((resolve) => {
    pty.onExit(({ exitCode, signal }) => {
      onDataSub.dispose();
      stdin.off("data", onStdin);
      stdout.off("resize", onResize);
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw);
      }
      stdin.pause();
      resolve({
        exitCode,
        signal: typeof signal === "number" ? signal : null,
        output: captured.join(""),
      });
    });
  });
}
