import { runClaudeSession } from "../claude/session.js";
import { loadConfig } from "../core/config.js";
import { loadState, saveState } from "../core/state.js";

export interface RunOptions {
  account?: string;
  args: string[];
}

export async function runClaudeCommand(opts: RunOptions): Promise<number> {
  const config = loadConfig();
  if (process.env.CCSWAP_REAL_CLAUDE) {
    config.claude_bin = process.env.CCSWAP_REAL_CLAUDE;
  }
  const state = loadState();
  if (opts.account) {
    state.active_account = opts.account;
    saveState(state);
  }
  let args = opts.args;
  if (args.length > 0 && args[0] === "--") args = args.slice(1);
  return await runClaudeSession({
    config,
    state,
    originalArgs: args,
    launchCwd: process.cwd(),
  });
}
