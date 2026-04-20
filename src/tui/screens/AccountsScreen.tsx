import { Box, Text } from "ink";

import type { AppStateData } from "../../core/state.js";
import type { AccountView } from "../useConfigState.js";
import { fitText, formatIsoLocal, formatUpdatedAt } from "../format.js";
import { UsageBar } from "../UsageBar.js";

interface Props {
  accounts: AccountView[];
  state: AppStateData;
  selectedIndex: number;
  width: number;
}

interface Column {
  label: string;
  width: number;
}

function layoutColumns(totalWidth: number): Column[] {
  const inner = Math.max(40, totalWidth - 3);
  const colMark = 1;   // ▌ selection bar
  const colActive = 2; // ★ / ·
  const colPlan = 8;
  const colAccount = Math.max(14, Math.min(28, Math.floor(inner * 0.25)));
  const gap = 4;
  const used = colMark + colActive + colAccount + colPlan + gap;
  const colUsage = Math.max(28, inner - used);
  return [
    { label: "", width: colMark },
    { label: "", width: colActive },
    { label: "Account", width: colAccount },
    { label: "Plan", width: colPlan },
    { label: "Usage", width: colUsage },
  ];
}

export function AccountsScreen({ accounts, state, selectedIndex, width }: Props) {
  const columns = layoutColumns(width);
  const selected = accounts[selectedIndex];
  const ruleWidth = Math.max(10, width - 2);
  const rule = "─".repeat(ruleWidth);
  const countLabel = accounts.length ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}` : "empty";

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">ACCOUNTS </Text>
        <Text color="gray">{"─".repeat(Math.max(2, width - 10 - countLabel.length - 2))} {countLabel}</Text>
      </Box>

      <Box marginTop={1} flexDirection="row">
        {columns.map((col, idx) => (
          <Box key={idx} width={col.width} marginRight={idx < columns.length - 1 ? 1 : 0}>
            <Text bold color="blue">{fitText(col.label, col.width)}</Text>
          </Box>
        ))}
      </Box>
      <Text color="gray">{rule}</Text>
      <Box marginTop={1} flexDirection="column">
      {accounts.length === 0 ? (
        <Box marginTop={1}>
          <Text color="gray">No accounts yet. Press 'a' to add one.</Text>
        </Box>
      ) : (
        accounts.map((view, idx) => {
          const isSelected = idx === selectedIndex;
          const isActive = state.active_account === view.account.name;
          const autoSwap = view.account.auto_swap;
          const nameColor = !view.loggedIn ? "red" : autoSwap ? "green" : "gray";
          const suffix = !autoSwap ? " (off)" : "";
          const marker = isSelected ? "▌" : " ";
          const markerColor = isSelected ? "magenta" : "gray";
          const activeIcon = isActive ? "★" : "·";
          const activeColor = isActive ? "yellow" : "gray";

          return (
            <Box key={view.account.name} flexDirection="row">
              <Box width={columns[0]!.width} marginRight={1}>
                <Text color={markerColor} bold>{marker}</Text>
              </Box>
              <Box width={columns[1]!.width} marginRight={1}>
                <Text color={activeColor} bold={isActive}>{activeIcon}</Text>
              </Box>
              <Box width={columns[2]!.width} marginRight={1}>
                <Text color={nameColor} bold={isSelected} dimColor={!autoSwap}>
                  {fitText(view.account.name + suffix, columns[2]!.width)}
                </Text>
              </Box>
              <Box width={columns[3]!.width} marginRight={1}>
                <Text color="gray">{fitText(view.subscriptionType ?? "-", columns[3]!.width)}</Text>
              </Box>
              <Box width={columns[4]!.width}>
                {view.loggedIn ? (
                  <Text>
                    <Text color="gray">5h </Text>
                    <UsageBar percent={view.usage.five_hour_pct} width={10} />
                    <Text color="gray">   7d </Text>
                    <UsageBar percent={view.usage.seven_day_pct} width={10} />
                  </Text>
                ) : (
                  <Text color="red">login needed</Text>
                )}
              </Box>
            </Box>
          );
        })
      )}
      </Box>

      <Box marginTop={1}>
        <Text bold color="cyan">DETAILS </Text>
        <Text color="gray">
          {"─".repeat(Math.max(2, width - 10 - (selected ? selected.account.name.length : 1) - 2))}{" "}
          {selected ? selected.account.name : "-"}
        </Text>
      </Box>
      {selected ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">
            {[
              state.active_account === selected.account.name ? "Active" : "Inactive",
              selected.account.auto_swap ? "auto-swap on" : "auto-swap off",
              `plan ${selected.subscriptionType ?? "-"}`,
              selected.loggedIn ? "logged in" : "no login",
            ].join(" · ")}
          </Text>
          <Text>
            <Text color="gray">5h </Text>
            <UsageBar percent={selected.usage.five_hour_pct} width={18} />
            <Text color="gray">  resets {formatIsoLocal(selected.usage.five_hour_reset_at)}</Text>
          </Text>
          <Text>
            <Text color="gray">7d </Text>
            <UsageBar percent={selected.usage.seven_day_pct} width={18} />
            <Text color="gray">  resets {formatIsoLocal(selected.usage.seven_day_reset_at)}</Text>
          </Text>
          <Text color="gray">updated {formatUpdatedAt(selected.usage.cache_timestamp_ms)}</Text>
        </Box>
      ) : (
        <Text color="gray">No account selected.</Text>
      )}
    </Box>
  );
}
