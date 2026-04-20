import { isReplayMode, OPTIONS_WITH_VALUE } from "../core/constants.js";
import type { SessionRuntimeState } from "../core/runtime.js";

export interface SplitResult {
  args: string[];
  prompt: string | null;
}

export function splitPromptFromArgs(args: string[]): SplitResult {
  if (args.length === 0) return { args: [], prompt: null };
  const result: string[] = [];
  const positional: string[] = [];
  let expectValue = false;
  for (const token of args) {
    if (expectValue) {
      result.push(token);
      expectValue = false;
      continue;
    }
    if (token === "--") {
      result.push(token);
      continue;
    }
    if (token.startsWith("-")) {
      result.push(token);
      const head = token.split("=")[0]!;
      if (OPTIONS_WITH_VALUE.has(token) || (!token.includes("=") && token.startsWith("--") && OPTIONS_WITH_VALUE.has(head))) {
        expectValue = !token.includes("=");
      }
      continue;
    }
    positional.push(token);
    result.push(token);
  }
  if (positional.length === 0) return { args: result, prompt: null };
  const prompt = positional[positional.length - 1]!;
  for (let i = result.length - 1; i >= 0; i -= 1) {
    if (result[i] === prompt) {
      result.splice(i, 1);
      break;
    }
  }
  return { args: result, prompt };
}

export function buildResumeArgs(
  originalArgs: string[],
  runtime: SessionRuntimeState,
  disableAutoContinue = false,
): string[] {
  if (disableAutoContinue) return originalArgs;
  if (originalArgs.some((arg) => arg === "-p" || arg === "--print")) return originalArgs;
  const sessionId = runtime.session_id;
  if (!sessionId) return originalArgs;

  const { args: filtered, prompt: originalPrompt } = splitPromptFromArgs(originalArgs);
  const resumeFiltered: string[] = [];
  let skipNext = false;
  for (let i = 0; i < filtered.length; i += 1) {
    const arg = filtered[i]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "-c" || arg === "--continue") continue;
    if ((arg === "-r" || arg === "--resume" || arg === "--session-id") && i + 1 < filtered.length) {
      skipNext = true;
      continue;
    }
    resumeFiltered.push(arg);
  }

  const replayMode = isReplayMode(runtime.replay_mode) ? runtime.replay_mode : "last_prompt";
  const resumeArgs = ["--resume", sessionId, ...resumeFiltered];

  let promptToSend: string | null = null;
  if (replayMode === "last_prompt") {
    promptToSend = runtime.last_prompt ?? originalPrompt;
  } else if (replayMode === "custom_prompt") {
    promptToSend = runtime.custom_prompt;
  }
  if (promptToSend) resumeArgs.push(promptToSend);
  return resumeArgs;
}

export function normalizeCliArgs(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  if (argv[0] !== "claude") return argv;
  if (argv.length === 1) return ["run"];
  return ["run", "--", ...argv.slice(1)];
}
