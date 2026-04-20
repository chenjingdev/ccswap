import { Box, Text } from "ink";

import type { RuntimeSessionView } from "../../core/runtime.js";
import { fitText, replayLabel } from "../format.js";

interface Column {
  label: string;
  width: number;
}

interface Props {
  sessions: RuntimeSessionView[];
  selectedIndex: number;
  replayMode: string;
  customPrompt: string;
  width: number;
}

function layoutColumns(totalWidth: number): Column[] {
  const notesWidth = Math.max(20, totalWidth - 58);
  return [
    { label: "", width: 2 },
    { label: "No.", width: 4 },
    { label: "Run", width: 10 },
    { label: "Account", width: 14 },
    { label: "Session ID", width: 14 },
    { label: "Replay", width: 14 },
    { label: "Cwd / Prompt", width: notesWidth },
  ];
}

export function SessionsScreen({ sessions, selectedIndex, replayMode, customPrompt, width }: Props) {
  const columns = layoutColumns(width);
  const selected = sessions[selectedIndex];
  const rule = "─".repeat(Math.max(10, width - 2));
  const sectionDetail = sessions.length
    ? `showing 1-${sessions.length} of ${sessions.length}`
    : "empty";

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">SESSIONS </Text>
        <Text color="gray">{"─".repeat(Math.max(2, width - 10 - sectionDetail.length - 2))} {sectionDetail}</Text>
      </Box>

      <Box marginTop={1} flexDirection="row">
        {columns.map((col, idx) => (
          <Box key={idx} width={col.width} marginRight={idx < columns.length - 1 ? 1 : 0}>
            <Text bold color="blue">{fitText(col.label, col.width)}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
      {sessions.length === 0 ? (
        <Text color="gray">No live ccswap sessions.</Text>
      ) : (
        sessions.map((item, idx) => {
          const isSelected = idx === selectedIndex;
          const color = isSelected ? "cyan" : "green";
          const runShort = item.state.run_id.slice(0, 8);
          const sessionShort = item.state.session_id ? item.state.session_id.slice(0, 12) : "-";
          const notes = item.state.last_prompt || item.state.custom_prompt || item.state.cwd || "-";
          const cells = [
            "",
            String(idx + 1),
            runShort,
            item.state.active_account ?? "-",
            sessionShort,
            replayLabel(item.state.replay_mode),
            notes,
          ];
          return (
            <Box key={item.path} flexDirection="row">
              {cells.map((cell, cidx) => {
                const col = columns[cidx]!;
                const isMarker = cidx === 0;
                return (
                  <Box key={cidx} width={col.width} marginRight={cidx < cells.length - 1 ? 1 : 0}>
                    {isMarker ? (
                      <Text backgroundColor={isSelected ? "magenta" : undefined}>
                        {" ".repeat(col.width)}
                      </Text>
                    ) : (
                      <Text bold={isSelected} color={color}>
                        {fitText(cell, col.width)}
                      </Text>
                    )}
                  </Box>
                );
              })}
            </Box>
          );
        })
      )}
      </Box>

      <Box marginTop={1}>
        <Text bold color="cyan">DETAILS </Text>
        <Text color="gray">
          {"─".repeat(Math.max(2, width - 10 - (selected ? selected.state.run_id.slice(0, 8).length : 1) - 2))}{" "}
          {selected ? selected.state.run_id.slice(0, 8) : "-"}
        </Text>
      </Box>
      {selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">{fitText(`Run ID: ${selected.state.run_id}`, Math.max(1, width - 2))}</Text>
          <Text color="gray">{fitText(`Session ID: ${selected.state.session_id ?? "-"}   Account: ${selected.state.active_account ?? "-"}`, Math.max(1, width - 2))}</Text>
          <Text color="gray">{fitText(`Replay mode: ${replayLabel(selected.state.replay_mode)}`, Math.max(1, width - 2))}</Text>
          <Text color="gray">{fitText(`Custom prompt: ${selected.state.custom_prompt ?? "-"}`, Math.max(1, width - 2))}</Text>
          <Text color="gray">{fitText(`Last prompt: ${selected.state.last_prompt ?? "-"}`, Math.max(1, width - 2))}</Text>
          <Text color="gray">{fitText(`Cwd: ${selected.state.cwd ?? "-"}   Started: ${selected.state.started_at ?? "-"}`, Math.max(1, width - 2))}</Text>
        </Box>
      ) : (
        <Text color="gray">
          Replay {replayLabel(replayMode)}
          {replayMode === "custom_prompt" && customPrompt ? `  ·  "${customPrompt}"` : ""}
        </Text>
      )}
    </Box>
  );
}
