import { Command } from "commander";

import { normalizeCliArgs } from "./claude/args.js";
import { runAccountAdd, runAccountList, runAccountRemove } from "./commands/account.js";
import { runClaudeCommand } from "./commands/claude.js";
import { runDashboard } from "./commands/dashboard.js";
import { runHookPromptSubmit, runHookSessionStart } from "./commands/hook.js";
import { runInit } from "./commands/init.js";
import { runLogin } from "./commands/login.js";
import { runUse } from "./commands/use.js";

function build(): Command {
  const program = new Command();
  program
    .name("ccswap")
    .description("Multi-account Claude Code switcher with auto-swap")
    .version("0.1.0-alpha.1")
    .enablePositionalOptions();

  program
    .command("init")
    .description("initialize ccswap config directory")
    .action(() => process.exit(runInit()));

  const account = program.command("account").description("manage accounts");
  account
    .command("add <name>")
    .description("add a new account")
    .action((name: string) => process.exit(runAccountAdd(name)));
  account
    .command("list")
    .alias("ls")
    .description("list accounts")
    .action(() => process.exit(runAccountList()));
  account
    .command("remove <name>")
    .alias("rm")
    .description("remove an account")
    .action((name: string) => process.exit(runAccountRemove(name)));

  program
    .command("login <name>")
    .description("run claude auth login and save credentials for this account")
    .action(async (name: string) => {
      process.exit(await runLogin(name));
    });

  program
    .command("use <name>")
    .description("switch active account")
    .action((name: string) => process.exit(runUse(name)));

  program
    .command("run")
    .description("run claude with auto-swap on limit")
    .option("--account <name>", "force this account as the initial active one")
    .passThroughOptions()
    .allowUnknownOption()
    .argument("[claude-args...]", "arguments forwarded to claude")
    .action(async (claudeArgs: string[], options: { account?: string }) => {
      process.exit(
        await runClaudeCommand({
          account: options.account,
          args: claudeArgs,
        }),
      );
    });

  program
    .command("claude")
    .description("shorthand: ccswap claude [args...] -> claude with auto-swap")
    .passThroughOptions()
    .allowUnknownOption()
    .argument("[claude-args...]", "arguments forwarded to claude")
    .action(async (claudeArgs: string[]) => {
      process.exit(await runClaudeCommand({ args: claudeArgs }));
    });

  const hook = program.command("hook", { hidden: true });
  hook
    .command("session-start")
    .requiredOption("--run-id <id>")
    .requiredOption("--state-path <path>")
    .action(async (options: { runId: string; statePath: string }) => {
      process.exit(await runHookSessionStart(options.runId, options.statePath));
    });
  hook
    .command("prompt-submit")
    .requiredOption("--run-id <id>")
    .requiredOption("--state-path <path>")
    .action(async (options: { runId: string; statePath: string }) => {
      process.exit(await runHookPromptSubmit(options.runId, options.statePath));
    });

  program
    .command("dashboard")
    .description("open the interactive TUI dashboard")
    .action(async () => {
      process.exit(await runDashboard());
    });

  program.action(async () => {
    process.exit(await runDashboard());
  });

  return program;
}

const program = build();
const rawArgv = process.argv.slice(2);
const normalized = normalizeCliArgs(rawArgv);
program.parseAsync([process.argv[0]!, process.argv[1]!, ...normalized]).catch((err) => {
  console.error(err);
  process.exit(1);
});
