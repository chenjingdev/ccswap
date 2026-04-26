import {
  getShimStatus,
  installClaudeShim,
  removeClaudeShim,
  type ShimInstallOptions,
} from "../core/shim.js";
import { loadDashboardStatus } from "../core/dashboard-state.js";

export interface ConnectionCommandOptions {
  path?: string;
  real?: string;
  ccswapBin?: string;
  force?: boolean;
}

function toInstallOptions(options: ConnectionCommandOptions): ShimInstallOptions {
  return {
    shimPath: options.path,
    realClaudePath: options.real,
    ccswapBin: options.ccswapBin,
    force: options.force,
  };
}

export function runConnect(options: ConnectionCommandOptions = {}): number {
  try {
    const result = installClaudeShim(toInstallOptions(options));
    process.stdout.write(
      [
        `[ccswap] Plain claude is now connected: ${result.shimPath}`,
        `[ccswap] Real Claude binary: ${result.realClaudePath}`,
        `[ccswap] ccswap entrypoint: ${result.ccswapBin}`,
        result.backupPath ? `[ccswap] Previous claude command moved to: ${result.backupPath}` : null,
      ].filter(Boolean).join("\n") + "\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(`[ccswap] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function runConnectionStatus(options: ConnectionCommandOptions = {}): number {
  try {
    const status = getShimStatus(toInstallOptions(options));
    const dashboard = loadDashboardStatus();
    process.stdout.write(
      [
        `plain_claude: ${status.installed ? "connected" : "not_connected"}`,
        `active_on_path: ${status.onPath ? "yes" : "no"}`,
        `dashboard: ${dashboard.running ? "running" : "stopped"}`,
        `dashboard_pid: ${dashboard.state?.pid ?? "-"}`,
        `dashboard_heartbeat: ${dashboard.state?.heartbeat_at ?? "-"}`,
        `command_path: ${status.shimPath}`,
        `path_command: ${status.pathCommand ?? "-"}`,
        `real_claude: ${status.realClaudePath ?? "-"}`,
        `ccswap_bin: ${status.ccswapBin ?? "-"}`,
        `backup_path: ${status.backupPath ?? "-"}`,
        `config_claude_bin: ${status.configClaudeBin}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(`[ccswap] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

export function runDisconnect(options: ConnectionCommandOptions = {}): number {
  try {
    const result = removeClaudeShim(toInstallOptions(options));
    process.stdout.write(
      [
        `[ccswap] Plain claude is disconnected: ${result.shimPath}`,
        `[ccswap] Real Claude binary restored: ${result.realClaudePath}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(`[ccswap] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
