import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";

import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";

import { saveConfig } from "../core/config.js";
import { REPLAY_MODES } from "../core/constants.js";
import { CONFIG_DIR, RUNTIME_DIR, USAGE_CACHE_DIR } from "../core/paths.js";
import {
  listRuntimeSessions,
  runtimeStatePath,
  updateRuntimeState,
  type SessionRuntimeState,
} from "../core/runtime.js";
import { ensureClaudeShim, getShimStatus, type EnsureClaudeShimResult, type ShimStatus } from "../core/shim.js";
import { refreshAccountUsage } from "../core/usage.js";
import { AccountsScreen } from "./screens/AccountsScreen.js";
import { SessionsScreen } from "./screens/SessionsScreen.js";
import { ConfirmModal } from "./modals/ConfirmModal.js";
import { EditAccountMenu } from "./modals/EditAccountMenu.js";
import { InputModal } from "./modals/InputModal.js";
import { useConfigState } from "./useConfigState.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { fitText } from "./format.js";
import type { AppStateData } from "../core/state.js";

type Screen = "accounts" | "sessions";
type Modal =
  | { kind: "edit"; name: string; autoSwap: boolean }
  | { kind: "confirm-delete"; name: string }
  | { kind: "custom-prompt"; runId: string | null; initialValue: string }
  | null;

export interface AppProps {
  onLoginRequested: (accountName: string) => void;
  onAddRequested: () => void;
  hasTty: boolean;
  initialConnection?: EnsureClaudeShimResult;
}

const ACCOUNT_SHORTCUTS: Array<[string, string]> = [
  ["Tab", "Sessions"],
  ["Enter", "Active"],
  ["a", "Add (login)"],
  ["l", "Re-login"],
  ["e", "Edit"],
  ["q", "Quit"],
];

const SESSION_SHORTCUTS: Array<[string, string]> = [
  ["Tab", "Accounts"],
  ["↑/↓", "Select"],
  ["s", "Switch acct"],
  ["m", "Replay mode"],
  ["p", "Custom prompt"],
  ["q", "Quit"],
];

function resolveDisplayActiveAccount(cfg: ReturnType<typeof useConfigState>): string | null {
  if (cfg.state.active_account && cfg.accounts.some((view) => view.account.name === cfg.state.active_account)) {
    return cfg.state.active_account;
  }
  const loggedIn = cfg.accounts.filter((view) => view.loggedIn);
  if (cfg.state.last_account && loggedIn.some((view) => view.account.name === cfg.state.last_account)) {
    return cfg.state.last_account;
  }
  return loggedIn[0]?.account.name ?? null;
}

function nextReplayMode(current: string): (typeof REPLAY_MODES)[number] {
  const idx = REPLAY_MODES.findIndex((mode) => mode === current);
  return REPLAY_MODES[((idx >= 0 ? idx : 0) + 1) % REPLAY_MODES.length]!;
}

function nextLoggedInAccount(
  accounts: ReturnType<typeof useConfigState>["accounts"],
  currentName: string | null,
): string | null {
  const loggedIn = accounts.filter((view) => view.loggedIn && !view.needsRelogin);
  if (loggedIn.length === 0) return null;
  if (!currentName) return loggedIn[0]?.account.name ?? null;
  const currentIndex = loggedIn.findIndex((view) => view.account.name === currentName);
  if (currentIndex < 0) return loggedIn[0]?.account.name ?? null;
  if (loggedIn.length === 1) return null;
  return loggedIn[(currentIndex + 1) % loggedIn.length]?.account.name ?? null;
}

function ensureMessage(result: EnsureClaudeShimResult): { text: string; kind: "ok" | "err" } {
  return {
    text: result.message,
    kind: result.kind === "connected" || result.kind === "installed" ? "ok" : "err",
  };
}

export function App({ onLoginRequested, onAddRequested, hasTty, initialConnection }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const cfg = useConfigState();
  const [screen, setScreen] = useState<Screen>("accounts");
  const [accountCursor, setAccountCursor] = useState(0);
  const [sessionCursor, setSessionCursor] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "err" } | null>(() =>
    initialConnection ? ensureMessage(initialConnection) : null,
  );
  const [connection, setConnection] = useState<ShimStatus>(() => initialConnection?.status ?? getShimStatus());
  const [runtimeSessions, setRuntimeSessions] = useState<SessionRuntimeState[]>(() => listRuntimeSessions());

  const reloadConnection = (): void => {
    setConnection(getShimStatus());
  };
  const repairConnection = (showMessage: boolean): void => {
    const result = ensureClaudeShim();
    setConnection(result.status);
    if (showMessage || result.kind === "installed") {
      setMessage(ensureMessage(result));
    }
  };
  const reloadRuntimeSessions = (): void => {
    setRuntimeSessions(listRuntimeSessions());
  };

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  useEffect(() => {
    let cancelled = false;
    const repair = (): void => {
      if (cancelled) return;
      const status = getShimStatus();
      setConnection(status);
      if (status.installed && status.onPath) return;
      repairConnection(false);
    };
    repair();
    const id = setInterval(repair, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Event-driven refresh: fs.watch on ccswap's own state dirs so the UI only
  // rebuilds when disk actually changes. Mirrors claude-hud's "no polling,
  // react to external signals" philosophy.
  useEffect(() => {
    for (const dir of [CONFIG_DIR, USAGE_CACHE_DIR, RUNTIME_DIR]) {
      if (!existsSync(dir)) {
        try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      }
    }

    const watchers: FSWatcher[] = [];
    const safeWatch = (path: string, handler: () => void): void => {
      try {
        watchers.push(watch(path, { persistent: false }, handler));
      } catch {
        // fs.watch may reject on platforms without inotify/FSEvents support;
        // the rotation tick below still pulls fresh data on its own cadence.
      }
    };

    safeWatch(CONFIG_DIR, () => {
      cfg.reload();
      reloadConnection();
      reloadRuntimeSessions();
    });
    safeWatch(USAGE_CACHE_DIR, () => cfg.reload());
    safeWatch(RUNTIME_DIR, reloadRuntimeSessions);

    return () => {
      for (const w of watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
    };
  }, [cfg.reload]);

  // API refresh rotation: statusLine rate_limits is the primary live source
  // during ccswap-run Claude sessions. This slower OAuth pass is just a
  // fallback for accounts without recent statusLine snapshots.
  useEffect(() => {
    let cancelled = false;
    let cursor = 0;
    const tick = async (): Promise<void> => {
      const candidates = cfg.accounts.filter((v) => v.loggedIn);
      if (candidates.length === 0) return;
      const target = candidates[cursor % candidates.length];
      cursor = (cursor + 1) % candidates.length;
      if (!target) return;
      try {
        await refreshAccountUsage(target.account, false);
      } catch {
        // ignore
      }
    };
    const id = setInterval(() => {
      if (!cancelled) void tick();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cfg.accounts.length]);

  const selectedAccount = cfg.accounts[accountCursor];
  const clampedSessionCursor = Math.min(sessionCursor, Math.max(0, runtimeSessions.length - 1));
  const selectedRuntimeSession = runtimeSessions[clampedSessionCursor] ?? null;

  const reloadRuntimeSessionsWithMessage = (text: string): void => {
    reloadRuntimeSessions();
    setMessage({ text, kind: "ok" });
  };

  useInput((input, key) => {
    if (modal) return;

    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.tab) {
      setScreen((s) => (s === "accounts" ? "sessions" : "accounts"));
      return;
    }
    if (screen === "accounts") {
      if (key.upArrow || input === "k") {
        setAccountCursor((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setAccountCursor((i) => Math.min(Math.max(0, cfg.accounts.length - 1), i + 1));
        return;
      }
      if (input === "a") {
        onAddRequested();
        return;
      }
      if (input === "e" && selectedAccount) {
        setModal({
          kind: "edit",
          name: selectedAccount.account.name,
          autoSwap: selectedAccount.account.auto_swap,
        });
        return;
      }
      if (key.return && selectedAccount) {
        const err = cfg.setActive(selectedAccount.account.name);
        setMessage(
          err
            ? { text: err, kind: "err" }
            : { text: `Active: ${selectedAccount.account.name}`, kind: "ok" },
        );
        return;
      }
      if (input === "l" && selectedAccount) {
        onLoginRequested(selectedAccount.account.name);
        return;
      }
    }

    if (screen === "sessions") {
      if (key.upArrow || input === "k") {
        setSessionCursor((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setSessionCursor((i) => Math.min(Math.max(0, runtimeSessions.length - 1), i + 1));
        return;
      }
      if (input === "m") {
        if (selectedRuntimeSession) {
          const next = nextReplayMode(selectedRuntimeSession.replay_mode);
          updateRuntimeState(runtimeStatePath(selectedRuntimeSession.run_id), selectedRuntimeSession.run_id, {
            replay_mode: next,
          });
          reloadRuntimeSessionsWithMessage(`Session replay mode: ${next}`);
        } else {
          const next = nextReplayMode(cfg.config.replay_mode);
          saveConfig({ ...cfg.config, replay_mode: next });
          cfg.reload();
          setMessage({ text: `Default replay mode: ${next}`, kind: "ok" });
        }
        return;
      }
      if (input === "s" && selectedRuntimeSession) {
        const nextAccount = nextLoggedInAccount(cfg.accounts, selectedRuntimeSession.active_account);
        if (!nextAccount) {
          setMessage({ text: "No other logged-in account for this session", kind: "err" });
          return;
        }
        const now = new Date().toISOString();
        updateRuntimeState(runtimeStatePath(selectedRuntimeSession.run_id), selectedRuntimeSession.run_id, {
          requested_account: nextAccount,
          requested_reason: "manual_session_switch",
          requested_at: now,
          safe_to_restart: selectedRuntimeSession.safe_to_restart,
        });
        reloadRuntimeSessionsWithMessage(`Session switch requested: ${nextAccount}`);
        return;
      }
      if (input === "p") {
        setModal({
          kind: "custom-prompt",
          runId: selectedRuntimeSession?.run_id ?? null,
          initialValue: selectedRuntimeSession?.custom_prompt ?? cfg.config.custom_prompt,
        });
        return;
      }
    }
  });

  const clampedAccountCursor = Math.min(accountCursor, Math.max(0, cfg.accounts.length - 1));
  const displayActiveAccount = resolveDisplayActiveAccount(cfg);
  const displayState: AppStateData = {
    ...cfg.state,
    active_account: displayActiveAccount,
  };

  const subtitleParts = [
    `active ${displayActiveAccount ?? "-"}`,
    connection.installed
      ? connection.onPath
        ? "plain claude ready"
        : "plain claude needs attention"
      : "plain claude auto-repairing",
  ];
  const subtitle = subtitleParts.join("  ·  ");

  const shortcuts = screen === "accounts" ? ACCOUNT_SHORTCUTS : SESSION_SHORTCUTS;
  const footerLine = "keys: " + shortcuts.map(([k, v]) => `${k} ${v}`).join("  ·  ");
  const footerRule = "─".repeat(Math.max(10, columns - 4));

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={2} paddingY={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="cyan">CCSWAP</Text>
        <Text color="gray">{subtitle}</Text>
      </Box>
      {message ? (
        <Box marginTop={1}>
          <Text color={message.kind === "err" ? "red" : "green"}>
            {fitText(message.text, Math.max(1, columns - 4))}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column" flexGrow={1}>
        {screen === "accounts" ? (
          <AccountsScreen
            accounts={cfg.accounts}
            state={displayState}
            selectedIndex={clampedAccountCursor}
            width={columns - 4}
          />
        ) : (
          <SessionsScreen
            config={cfg.config}
            sessions={runtimeSessions}
            selectedIndex={clampedSessionCursor}
            width={columns - 4}
          />
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">{footerRule}</Text>
        <Box marginTop={1}>
          <Text color="gray">{fitText(footerLine, Math.max(1, columns - 4))}</Text>
        </Box>
        {!hasTty ? <Text color="red">(stdin is not a TTY — key input may not work)</Text> : null}
      </Box>

      {modal?.kind === "edit" ? (
        <EditAccountMenu
          name={modal.name}
          autoSwap={modal.autoSwap}
          onCancel={() => setModal(null)}
          onToggleAutoSwap={() => {
            cfg.toggleAutoSwap(modal.name);
            const nextState = !modal.autoSwap;
            setModal(null);
            setMessage({ text: `Auto-swap ${nextState ? "on" : "off"} for '${modal.name}'`, kind: "ok" });
          }}
          onDelete={() => setModal({ kind: "confirm-delete", name: modal.name })}
        />
      ) : null}

      {modal?.kind === "confirm-delete" ? (
        <ConfirmModal
          title="Delete account"
          message={`Remove '${modal.name}' and forget its saved login?`}
          onCancel={() => setModal(null)}
          onConfirm={() => {
            const err = cfg.removeAccount(modal.name);
            setModal(null);
            setMessage(err ? { text: err, kind: "err" } : { text: `Deleted '${modal.name}'`, kind: "ok" });
          }}
        />
      ) : null}

      {modal?.kind === "custom-prompt" ? (
        <InputModal
          title={modal.runId ? "Session custom prompt" : "Default custom prompt"}
          placeholder="Continue from the previous work..."
          initialValue={modal.initialValue}
          onCancel={() => setModal(null)}
          onSubmit={(value) => {
            if (modal.runId) {
              updateRuntimeState(runtimeStatePath(modal.runId), modal.runId, {
                custom_prompt: value || null,
                replay_mode: "custom_prompt",
              });
              reloadRuntimeSessions();
            } else {
              saveConfig({ ...cfg.config, custom_prompt: value, replay_mode: "custom_prompt" });
              cfg.reload();
            }
            setModal(null);
            setMessage({ text: modal.runId ? "Session custom prompt saved" : "Default custom prompt saved", kind: "ok" });
          }}
        />
      ) : null}
    </Box>
  );
}
