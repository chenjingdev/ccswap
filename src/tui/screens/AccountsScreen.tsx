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
  const inner = Math.max(50, totalWidth - 3);
  const colCursor = 2;
  const colNumber = 4;
  const colActive = 8;
  const colSwap = 6;
  const colAccount = Math.max(12, Math.min(18, Math.floor(inner / 5)));
  const colLogin = 7;
  const colPlan = 8;
  const gap = 7;
  const used = colCursor + colNumber + colActive + colSwap + colAccount + colLogin + colPlan + gap;
  const colUsage = Math.max(24, inner - used);
  return [
    { label: "", width: colCursor },
    { label: "No.", width: colNumber },
    { label: "Active", width: colActive },
    { label: "Swap", width: colSwap },
    { label: "Account", width: colAccount },
    { label: "Auth", width: colLogin },
    { label: "Plan", width: colPlan },
    { label: "Usage", width: colUsage },
  ];
}

function Row({
  cells,
  columns,
  selected,
}: {
  cells: React.ReactNode[];
  columns: Column[];
  selected: boolean;
}) {
  return (
    <Box flexDirection="row">
      {cells.map((cell, idx) => {
        const col = columns[idx]!;
        return (
          <Box key={idx} width={col.width} marginRight={idx < cells.length - 1 ? 1 : 0}>
            {typeof cell === "string" ? (
              <Text bold={selected}>{fitText(cell, col.width)}</Text>
            ) : (
              cell
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function AccountsScreen({ accounts, state, selectedIndex, width }: Props) {
  const columns = layoutColumns(width);
  const selected = accounts[selectedIndex];

  const headerCells = columns.map((col, idx) => (
    <Text key={idx} bold underline color="blue">
      {fitText(col.label, col.width)}
    </Text>
  ));

  const ruleWidth = Math.max(10, width - 2);
  const rule = "─".repeat(ruleWidth);

  const sectionDetail = accounts.length
    ? `showing 1-${accounts.length} of ${accounts.length}`
    : "empty";

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">ACCOUNTS </Text>
        <Text color="gray">{"─".repeat(Math.max(2, width - 10 - sectionDetail.length - 2))} {sectionDetail}</Text>
      </Box>
      <Box marginTop={1}>
        <Row cells={headerCells} columns={columns} selected={false} />
      </Box>
      <Text color="gray">{rule}</Text>

      {accounts.length === 0 ? (
        <Box marginTop={1}>
          <Text color="gray">No accounts yet. Press 'a' to add one.</Text>
        </Box>
      ) : (
        accounts.map((view, idx) => {
          const isSelected = idx === selectedIndex;
          const isActive = state.active_account === view.account.name;
          const color = !view.loggedIn ? "red" : isSelected ? "cyan" : "green";
          const usageCell = view.loggedIn ? (
            <Text>
              <Text color="gray">5h </Text>
              <UsageBar percent={view.usage.five_hour_pct} width={6} />
              <Text color="gray">  7d </Text>
              <UsageBar percent={view.usage.seven_day_pct} width={6} />
            </Text>
          ) : (
            <Text color="red">login needed</Text>
          );
          const cells = [
            <Text key="bar" color="magenta" bold>{isSelected ? "▌" : " "}</Text>,
            <Text key="no" color={color} bold={isSelected}>{fitText(String(idx + 1), columns[1]!.width)}</Text>,
            <Text key="act" color={color} bold={isSelected}>{fitText(isActive ? "Current" : "-", columns[2]!.width)}</Text>,
            <Text key="swap" color={color} bold={isSelected}>{fitText(view.account.auto_swap ? "[x]" : "[ ]", columns[3]!.width)}</Text>,
            <Text key="name" color={color} bold={isSelected}>{fitText(view.account.name, columns[4]!.width)}</Text>,
            <Text key="auth" color={color} bold={isSelected}>{fitText(view.loggedIn ? "Y" : "N", columns[5]!.width)}</Text>,
            <Text key="plan" color={color} bold={isSelected}>{fitText(view.subscriptionType ?? "-", columns[6]!.width)}</Text>,
            usageCell,
          ];
          return <Row key={view.account.name} cells={cells} columns={columns} selected={isSelected} />;
        })
      )}

      <Box marginTop={1}>
        <Text bold color="cyan">DETAILS </Text>
        <Text color="gray">{"─".repeat(Math.max(2, width - 10 - (selected ? selected.account.name.length : 1) - 2))} {selected ? selected.account.name : "-"}</Text>
      </Box>
      <Text color="gray">{rule}</Text>
      {selected ? (
        <Box flexDirection="column">
          <Text color="gray">
            {fitText(
              `Account: ${selected.account.name}   Active: ${state.active_account === selected.account.name ? "Yes" : "No"}   Auto-swap: ${selected.account.auto_swap ? "Included" : "Excluded"}`,
              Math.max(1, width - 2),
            )}
          </Text>
          <Text color="gray">
            {fitText(
              `Saved login: ${selected.loggedIn ? "Yes" : "No"}   Plan: ${selected.subscriptionType ?? "-"}`,
              Math.max(1, width - 2),
            )}
          </Text>
          <Text>
            <Text color="gray">5h usage: </Text>
            <UsageBar percent={selected.usage.five_hour_pct} width={16} />
            <Text color="gray">   Reset: {formatIsoLocal(selected.usage.five_hour_reset_at)}</Text>
          </Text>
          <Text>
            <Text color="gray">7d usage: </Text>
            <UsageBar percent={selected.usage.seven_day_pct} width={16} />
            <Text color="gray">   Reset: {formatIsoLocal(selected.usage.seven_day_reset_at)}</Text>
          </Text>
          <Text color="gray">
            {fitText(`Updated: ${formatUpdatedAt(selected.usage.cache_timestamp_ms)}`, Math.max(1, width - 2))}
          </Text>
        </Box>
      ) : (
        <Text color="gray">No account selected.</Text>
      )}
    </Box>
  );
}
