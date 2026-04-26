import { Box, Text } from "ink";

import type { AppConfigData } from "../../core/config.js";
import type { SessionRuntimeState } from "../../core/runtime.js";
import { fitText, formatIsoLocal, replayLabel } from "../format.js";

interface Props {
  config: AppConfigData;
  sessions: SessionRuntimeState[];
  selectedIndex: number;
  width: number;
}

const DETAIL_LABEL_WIDTH = 16;

export function SessionsScreen({ config, sessions, selectedIndex, width }: Props) {
  const rule = "─".repeat(Math.max(10, width - 2));
  const selectedSession = sessions[selectedIndex] ?? null;
  const replayMode = selectedSession?.replay_mode ?? config.replay_mode;
  const customPrompt = (selectedSession ? selectedSession.custom_prompt : config.custom_prompt) || "-";
  const accountSwitch = selectedSession?.requested_account
    ? `pending -> ${selectedSession.requested_account}`
    : selectedSession?.swap_wait_until
      ? `waiting reset -> ${formatIsoLocal(selectedSession.swap_wait_until)}`
    : selectedSession
      ? "none"
      : "-";

  const rows: Array<[string, string]> = [
    ["Account switch", accountSwitch],
    ...(selectedSession?.auth_error_account
      ? ([["Auth issue", `${selectedSession.auth_error_account}: ${selectedSession.auth_error_reason ?? "re-login required"}`]] as Array<[string, string]>)
      : []),
    [selectedSession ? "Replay mode" : "Default replay", replayLabel(replayMode)],
    ["Custom prompt", customPrompt],
  ];

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">SESSIONS </Text>
        <Text color="gray">{rule.slice(0, Math.max(2, width - 12))}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {sessions.length === 0 ? (
          <Text color="gray">No ccswap-managed Claude sessions are running.</Text>
        ) : (
          sessions.map((session, index) => (
            <SessionRow
              key={session.run_id}
              session={session}
              selected={index === selectedIndex}
              width={width}
            />
          ))
        )}
      </Box>
      <Box marginTop={sessions.length === 0 ? 2 : 1} flexDirection="column">
        {rows.map(([label, value]) => (
          <Text key={label} color="gray">
            <Text bold>{label.padEnd(DETAIL_LABEL_WIDTH)}</Text>
            {fitText(value, Math.max(1, width - DETAIL_LABEL_WIDTH))}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function SessionRow({
  session,
  selected,
  width,
}: {
  session: SessionRuntimeState;
  selected: boolean;
  width: number;
}) {
  const account = session.active_account ?? "-";
  const cwd = session.cwd ?? "-";
  const sessionId = session.session_id ? session.session_id.slice(0, 8) : "-";
  const status = session.requested_account
    ? `switch -> ${session.requested_account}`
    : session.auth_error_account
    ? "re-login required"
    : session.swap_pending
    ? "swap pending"
    : session.swap_wait_until
    ? "waiting reset"
    : session.safe_to_restart
      ? "restart ready"
      : session.claude_pid
        ? "running"
        : "starting";
  const meta = [
    account,
    status,
    `session ${sessionId}`,
    formatIsoLocal(session.started_at),
    replayLabel(session.replay_mode),
  ].join("  ·  ");

  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold={selected} color={selected ? "cyan" : "white"}>
        {fitText(`${selected ? ">" : " "} ${meta}`, width)}
      </Text>
      <Text color="gray">{fitText(`  ${cwd}`, width)}</Text>
    </Box>
  );
}
