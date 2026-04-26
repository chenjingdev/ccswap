import { Command } from "commander";

import { normalizeCliArgs } from "./claude/args.js";
import { runAccountAdd, runAccountList, runAccountRemove } from "./commands/account.js";
import { runClaudeCommand } from "./commands/claude.js";
import { runConnect, runConnectionStatus, runDisconnect } from "./commands/connection.js";
import { runDashboard } from "./commands/dashboard.js";
import { runInit } from "./commands/init.js";
import { runLogin } from "./commands/login.js";
import { runTokenProbe } from "./commands/token-probe.js";
import { runUse } from "./commands/use.js";
import { runUsageCapture } from "./commands/usage-capture.js";

function optionValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

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
    .command("token-probe <name>")
    .description("experiment: run Claude with this account's OAuth token in the child env")
    .option("--infer", "also run a tiny Claude inference after auth status succeeds")
    .action((name: string, options: { infer?: boolean }) => {
      process.exit(runTokenProbe(name, { infer: options.infer }));
    });

  program
    .command("connect")
    .description("connect plain `claude` to ccswap")
    .option("--path <path>", "path to connect as the claude command")
    .option("--real <path>", "real Claude binary to run behind the connection")
    .option("--ccswap-bin <path>", "ccswap executable the connection should call")
    .option("--force", "create a numbered backup if the default backup path exists")
    .action((options: { path?: string; real?: string; ccswapBin?: string; force?: boolean }) => {
      process.exit(runConnect(options));
    });

  program
    .command("status")
    .description("show dashboard and plain `claude` connection status")
    .option("--path <path>", "path to inspect")
    .action((options: { path?: string }) => {
      process.exit(runConnectionStatus(options));
    });

  program
    .command("disconnect")
    .description("disconnect plain `claude` from ccswap and restore the previous command")
    .option("--path <path>", "path to disconnect")
    .action((options: { path?: string }) => {
      process.exit(runDisconnect(options));
    });

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

  program
    .command("dashboard")
    .description("open the interactive TUI dashboard")
    .action(async () => {
      process.exit(await runDashboard());
    });

  program
    .command("usage-capture")
    .description("capture Claude Code statusline rate limits")
    .option("--account <name>", "account name")
    .option("--passthrough <base64>", "base64-encoded statusline command to run after capture")
    .action((options: { account?: string; passthrough?: string }) => {
      const account = options.account ?? optionValue(process.argv, "--account");
      const passthrough = options.passthrough ?? optionValue(process.argv, "--passthrough");
      if (!account) process.exit(0);
      process.exit(runUsageCapture({ account, passthrough }));
    });

  return program;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === "usage-capture") {
    const account = optionValue(rawArgv, "--account");
    const passthrough = optionValue(rawArgv, "--passthrough");
    process.exit(account ? runUsageCapture({ account, passthrough }) : 0);
  }
  const normalized = normalizeCliArgs(rawArgv);
  if (normalized.length === 0) {
    process.exit(await runDashboard());
  }
  const program = build();
  await program.parseAsync([process.argv[0]!, process.argv[1]!, ...normalized]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
