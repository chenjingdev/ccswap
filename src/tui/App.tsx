import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useState } from "react";

import { REPLAY_MODES } from "../core/constants.js";
import { saveConfig } from "../core/config.js";
import { listRuntimeSessions, type RuntimeSessionView } from "../core/runtime.js";
import { refreshAccountUsage } from "../core/usage.js";
import { AccountsScreen } from "./screens/AccountsScreen.js";
import { SessionsScreen } from "./screens/SessionsScreen.js";
import { InputModal } from "./modals/InputModal.js";
import { ConfirmModal } from "./modals/ConfirmModal.js";
import { useConfigState } from "./useConfigState.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { fitText, replayLabel } from "./format.js";

type Screen = "accounts" | "sessions";
type Modal =
  | { kind: "add" }
  | { kind: "rename"; current: string }
  | { kind: "confirm-delete"; name: string }
  | { kind: "custom-prompt" }
  | null;

export interface AppProps {
  onLoginRequested: (accountName: string) => void;
  hasTty: boolean;
}

const ACCOUNT_SHORTCUTS: Array<[string, string]> = [
  ["Tab", "Sessions"],
  ["a", "Add"],
  ["l", "Login"],
  ["r", "Rename"],
  ["Enter", "Set active"],
  ["Space", "Swap"],
  ["d", "Delete"],
  ["q", "Quit"],
];

const SESSION_SHORTCUTS: Array<[string, string]> = [
  ["Tab", "Accounts"],
  ["j/k", "Move"],
  ["m", "Replay mode"],
  ["p", "Custom prompt"],
  ["q", "Quit"],
];

export function App({ onLoginRequested, hasTty }: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const cfg = useConfigState();
  const [screen, setScreen] = useState<Screen>("accounts");
  const [accountCursor, setAccountCursor] = useState(0);
  const [sessionCursor, setSessionCursor] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [message, setMessage] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [sessions, setSessions] = useState<RuntimeSessionView[]>(() => listRuntimeSessions());

  useEffect(() => {
    const t = setInterval(() => {
      setSessions(listRuntimeSessions());
    }, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  // Background usage refresh — round-robin over accounts that have a login.
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
        if (!cancelled) cfg.reload();
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cfg.accounts.length, cfg.reload]);

  const selectedAccount = cfg.accounts[accountCursor];

  const cycleReplayMode = (): void => {
    const next = cfg.config;
    const idx = REPLAY_MODES.indexOf(next.replay_mode);
    const modeNext = REPLAY_MODES[(idx + 1) % REPLAY_MODES.length]!;
    next.replay_mode = modeNext;
    saveConfig(next);
    cfg.reload();
    setMessage({ text: `Replay mode: ${replayLabel(modeNext)}`, kind: "ok" });
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
        setModal({ kind: "add" });
        return;
      }
      if (input === "r" && selectedAccount) {
        setModal({ kind: "rename", current: selectedAccount.account.name });
        return;
      }
      if (input === "d" && selectedAccount) {
        setModal({ kind: "confirm-delete", name: selectedAccount.account.name });
        return;
      }
      if (input === " " && selectedAccount) {
        cfg.toggleAutoSwap(selectedAccount.account.name);
        return;
      }
      if (key.return && selectedAccount) {
        const err = cfg.setActive(selectedAccount.account.name);
        setMessage(
          err
            ? { text: err, kind: "err" }
            : { text: `Active account set to '${selectedAccount.account.name}'`, kind: "ok" },
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
        setSessionCursor((i) => Math.min(Math.max(0, sessions.length - 1), i + 1));
        return;
      }
      if (input === "m") {
        cycleReplayMode();
        return;
      }
      if (input === "p") {
        setModal({ kind: "custom-prompt" });
        return;
      }
    }
  });

  const clampedAccountCursor = Math.min(accountCursor, Math.max(0, cfg.accounts.length - 1));
  const clampedSessionCursor = Math.min(sessionCursor, Math.max(0, sessions.length - 1));
  const selectedLabel =
    screen === "accounts" && cfg.accounts.length > 0
      ? `${clampedAccountCursor + 1}/${cfg.accounts.length}`
      : screen === "sessions" && sessions.length > 0
        ? `${clampedSessionCursor + 1}/${sessions.length}`
        : "0/0";

  const subtitle = `replay ${replayLabel(cfg.config.replay_mode)}  active ${cfg.state.active_account ?? "-"}  screen ${screen}  selected ${selectedLabel}`;
  const infoText = message ? message.text : "Ready";
  const infoColor = message ? (message.kind === "err" ? "red" : "green") : "gray";

  const shortcuts = screen === "accounts" ? ACCOUNT_SHORTCUTS : SESSION_SHORTCUTS;
  const footerLine = "keys: " + shortcuts.map(([k, v]) => `${k} ${v}`).join("  ·  ");
  const footerRule = "─".repeat(Math.max(10, columns - 2));

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box paddingX={1} flexDirection="column">
        <Text bold color="cyan">CCSWAP</Text>
        <Text color="gray">{fitText(subtitle, Math.max(1, columns - 2))}</Text>
        <Text color={infoColor}>{fitText(`info  ${infoText}`, Math.max(1, columns - 2))}</Text>
      </Box>

      <Box paddingX={1} flexDirection="column" flexGrow={1}>
        {screen === "accounts" ? (
          <AccountsScreen
            accounts={cfg.accounts}
            state={cfg.state}
            selectedIndex={clampedAccountCursor}
            width={columns - 2}
          />
        ) : (
          <SessionsScreen
            sessions={sessions}
            selectedIndex={clampedSessionCursor}
            replayMode={cfg.config.replay_mode}
            customPrompt={cfg.config.custom_prompt}
            width={columns - 2}
          />
        )}
      </Box>

      <Box paddingX={1} flexDirection="column">
        <Text color="gray">{footerRule}</Text>
        <Text color="gray">{fitText(footerLine, Math.max(1, columns - 2))}</Text>
        {!hasTty ? <Text color="red">(stdin is not a TTY — key input may not work)</Text> : null}
      </Box>

      {modal?.kind === "add" ? (
        <InputModal
          title="Add account"
          placeholder="name"
          onCancel={() => setModal(null)}
          onSubmit={(name) => {
            if (!name) {
              setModal(null);
              return;
            }
            const err = cfg.addAccount(name);
            setModal(null);
            setMessage(err ? { text: err, kind: "err" } : { text: `Added '${name}'`, kind: "ok" });
          }}
        />
      ) : null}

      {modal?.kind === "rename" ? (
        <InputModal
          title={`Rename '${modal.current}'`}
          initialValue={modal.current}
          onCancel={() => setModal(null)}
          onSubmit={(newName) => {
            if (!newName || newName === modal.current) {
              setModal(null);
              return;
            }
            const err = cfg.renameAccount(modal.current, newName);
            setModal(null);
            setMessage(err ? { text: err, kind: "err" } : { text: `Renamed to '${newName}'`, kind: "ok" });
          }}
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
          title="Custom replay prompt"
          initialValue={cfg.config.custom_prompt}
          onCancel={() => setModal(null)}
          onSubmit={(value) => {
            const next = cfg.config;
            next.custom_prompt = value;
            saveConfig(next);
            cfg.reload();
            setModal(null);
            setMessage({ text: "Custom prompt saved", kind: "ok" });
          }}
        />
      ) : null}
    </Box>
  );
}
