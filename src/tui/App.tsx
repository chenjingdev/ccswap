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
import { EditAccountMenu } from "./modals/EditAccountMenu.js";
import { useConfigState } from "./useConfigState.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { fitText, replayLabel } from "./format.js";

type Screen = "accounts" | "sessions";
type Modal =
  | { kind: "add" }
  | { kind: "edit"; name: string; autoSwap: boolean }
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
  ["Enter", "Active"],
  ["a", "Add"],
  ["l", "Login"],
  ["e", "Edit"],
  ["q", "Quit"],
];

const SESSION_SHORTCUTS: Array<[string, string]> = [
  ["Tab", "Accounts"],
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
    const t = setInterval(() => setSessions(listRuntimeSessions()), 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

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

  const subtitleParts = [
    `active ${cfg.state.active_account ?? "-"}`,
    replayLabel(cfg.config.replay_mode),
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
            state={cfg.state}
            selectedIndex={clampedAccountCursor}
            width={columns - 4}
          />
        ) : (
          <SessionsScreen
            sessions={sessions}
            selectedIndex={clampedSessionCursor}
            replayMode={cfg.config.replay_mode}
            customPrompt={cfg.config.custom_prompt}
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

      {modal?.kind === "edit" ? (
        <EditAccountMenu
          name={modal.name}
          autoSwap={modal.autoSwap}
          onCancel={() => setModal(null)}
          onRename={() => setModal({ kind: "rename", current: modal.name })}
          onToggleAutoSwap={() => {
            cfg.toggleAutoSwap(modal.name);
            const nextState = !modal.autoSwap;
            setModal(null);
            setMessage({ text: `Auto-swap ${nextState ? "on" : "off"} for '${modal.name}'`, kind: "ok" });
          }}
          onDelete={() => setModal({ kind: "confirm-delete", name: modal.name })}
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
