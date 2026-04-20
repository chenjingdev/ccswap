import { Box, Text } from "ink";

import type { RuntimeSessionView } from "../../core/runtime.js";

interface Props {
  sessions: RuntimeSessionView[];
  selectedIndex: number;
  replayMode: string;
  customPrompt: string;
}

function replayLabel(mode: string): string {
  switch (mode) {
    case "last_prompt":
      return "Last prompt";
    case "continue":
      return "Continue only";
    case "custom_prompt":
      return "Custom prompt";
    default:
      return mode;
  }
}

function truncate(value: string | null | undefined, width: number): string {
  if (!value) return "";
  if (value.length <= width) return value;
  return value.slice(0, width - 1) + "…";
}

export function SessionsScreen({ sessions, selectedIndex, replayMode, customPrompt }: Props) {
  return (
    <Box flexDirection="column">
      <Box paddingX={1} marginBottom={1}>
        <Text>
          Replay: <Text bold color="cyan">{replayLabel(replayMode)}</Text>
          {replayMode === "custom_prompt" && customPrompt ? (
            <Text color="gray">  ·  &quot;{truncate(customPrompt, 40)}&quot;</Text>
          ) : null}
        </Text>
      </Box>
      {sessions.length === 0 ? (
        <Box paddingX={1}>
          <Text color="gray">No active Claude sessions.</Text>
        </Box>
      ) : (
        <>
          <Box paddingX={1}>
            <Box width={3}><Text bold> </Text></Box>
            <Box width={20}><Text bold underline>Account</Text></Box>
            <Box width={10}><Text bold underline>PID</Text></Box>
            <Box width={40}><Text bold underline>Last prompt</Text></Box>
          </Box>
          {sessions.map((session, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <Box key={session.path} paddingX={1}>
                <Box width={3}>
                  <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "›" : " "}</Text>
                </Box>
                <Box width={20}>
                  <Text>{session.state.active_account ?? "-"}</Text>
                </Box>
                <Box width={10}>
                  <Text color="gray">{session.state.claude_pid ?? "-"}</Text>
                </Box>
                <Box width={40}>
                  <Text color="gray">{truncate(session.state.last_prompt, 38)}</Text>
                </Box>
              </Box>
            );
          })}
        </>
      )}
    </Box>
  );
}
