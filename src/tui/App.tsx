import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

import { REPLAY_MODES } from "../core/constants.js";
import { listRuntimeSessions, type RuntimeSessionView } from "../core/runtime.js";
import { saveConfig } from "../core/config.js";
import { AccountsScreen } from "./screens/AccountsScreen.js";
import { SessionsScreen } from "./screens/SessionsScreen.js";
import { InputModal } from "./modals/InputModal.js";
import { ConfirmModal } from "./modals/ConfirmModal.js";
import { useConfigState } from "./useConfigState.js";

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

export function App({ onLoginRequested, hasTty }: AppProps) {
  const { exit } = useApp();
  const cfg = useConfigState();
  const [screen, setScreen] = useState<Screen>("accounts");
  const [accountCursor, setAccountCursor] = useState(0);
  const [sessionCursor, setSessionCursor] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [flash, setFlash] = useState<{ text: string; color: string } | null>(null);
  const [sessions, setSessions] = useState<RuntimeSessionView[]>(() => listRuntimeSessions());

  useEffect(() => {
    const t = setInterval(() => {
      setSessions(listRuntimeSessions());
    }, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const selectedAccount = cfg.accounts[accountCursor];

  const cycleReplayMode = (): void => {
    const next = cfg.config;
    const idx = REPLAY_MODES.indexOf(next.replay_mode);
    const modeNext = REPLAY_MODES[(idx + 1) % REPLAY_MODES.length]!;
    next.replay_mode = modeNext;
    saveConfig(next);
    cfg.reload();
    setFlash({ text: `Replay mode: ${modeNext}`, color: "cyan" });
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
        setAccountCursor((i) => Math.min(cfg.accounts.length - 1, i + 1));
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
        setFlash(err ? { text: err, color: "red" } : { text: `Active: ${selectedAccount.account.name}`, color: "green" });
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

  const header = useMemo(() => {
    const tabs = (
      <Text>
        {screen === "accounts" ? (
          <>
            <Text bold color="cyan">Accounts</Text>
            <Text color="gray">  ·  Sessions</Text>
          </>
        ) : (
          <>
            <Text color="gray">Accounts  ·  </Text>
            <Text bold color="cyan">Sessions</Text>
          </>
        )}
      </Text>
    );
    return (
      <Box paddingX={1} marginBottom={1} flexDirection="column">
        <Text bold>ccswap</Text>
        {tabs}
      </Box>
    );
  }, [screen]);

  const helpLine = screen === "accounts"
    ? "j/k: move  Enter: activate  a: add  r: rename  d: delete  l: login  space: toggle auto-swap  Tab: sessions  q: quit"
    : "j/k: move  m: replay mode  p: custom prompt  Tab: accounts  q: quit";

  return (
    <Box flexDirection="column">
      {header}
      {screen === "accounts" ? (
        <AccountsScreen
          accounts={cfg.accounts}
          state={cfg.state}
          selectedIndex={Math.min(accountCursor, Math.max(0, cfg.accounts.length - 1))}
        />
      ) : (
        <SessionsScreen
          sessions={sessions}
          selectedIndex={Math.min(sessionCursor, Math.max(0, sessions.length - 1))}
          replayMode={cfg.config.replay_mode}
          customPrompt={cfg.config.custom_prompt}
        />
      )}

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
            setFlash(err ? { text: err, color: "red" } : { text: `Added ${name}`, color: "green" });
          }}
        />
      ) : null}

      {modal?.kind === "rename" ? (
        <InputModal
          title={`Rename "${modal.current}"`}
          initialValue={modal.current}
          onCancel={() => setModal(null)}
          onSubmit={(newName) => {
            if (!newName || newName === modal.current) {
              setModal(null);
              return;
            }
            const err = cfg.renameAccount(modal.current, newName);
            setModal(null);
            setFlash(err ? { text: err, color: "red" } : { text: `Renamed to ${newName}`, color: "green" });
          }}
        />
      ) : null}

      {modal?.kind === "confirm-delete" ? (
        <ConfirmModal
          title="Delete account"
          message={`Remove "${modal.name}" and forget its saved login?`}
          onCancel={() => setModal(null)}
          onConfirm={() => {
            const err = cfg.removeAccount(modal.name);
            setModal(null);
            setFlash(err ? { text: err, color: "red" } : { text: `Deleted ${modal.name}`, color: "yellow" });
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
            setFlash({ text: "Custom prompt saved", color: "green" });
          }}
        />
      ) : null}

      <Box marginTop={1} paddingX={1} flexDirection="column">
        {flash ? <Text color={flash.color}>{flash.text}</Text> : <Text> </Text>}
        <Text color="gray">{helpLine}</Text>
        {!hasTty ? <Text color="red">(stdin is not a TTY — key input may not work)</Text> : null}
      </Box>
    </Box>
  );
}
