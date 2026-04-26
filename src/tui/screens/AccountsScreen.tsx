import { platform } from "node:os";

import { Box, Text } from "ink";

import type { AppStateData } from "../../core/state.js";
import type { AccountView } from "../useConfigState.js";
import {
  credentialStoreLabel,
  fitText,
  formatAgo,
  formatIsoLocal,
  formatRelativeFromNow,
  formatUpdatedAt,
} from "../format.js";
import { UsageBar } from "../UsageBar.js";

interface Props {
  accounts: AccountView[];
  state: AppStateData;
  selectedIndex: number;
  thresholdPct: number | null;
  width: number;
}

interface Column {
  label: string;
  width: number;
}

function layoutColumns(totalWidth: number): Column[] {
  const inner = Math.max(40, totalWidth - 3);
  const colMark = 1;   // ▌ selection bar
  const colDefault = 8;
  const colPlan = 8;
  const colUpdated = 12;
  const gap = 6;
  const fixedWithoutAccount = colMark + colDefault + colPlan + colUpdated + gap;
  const colAccount = Math.max(18, Math.min(34, Math.floor(inner * 0.3)));
  const remaining = inner - fixedWithoutAccount - colAccount;
  const colUsage = Math.max(14, Math.floor(remaining / 2));
  return [
    { label: "", width: colMark },
    { label: "Default", width: colDefault },
    { label: "Account", width: colAccount },
    { label: "Plan", width: colPlan },
    { label: "Usage(5h)", width: colUsage },
    { label: "Usage(7d)", width: colUsage },
    { label: "Updated", width: colUpdated },
  ];
}

function usageBarWidth(columnWidth: number): number {
  return Math.max(4, columnWidth - 5);
}

export function AccountsScreen({ accounts, state, selectedIndex, thresholdPct, width }: Props) {
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
      <Box marginTop={1} flexDirection="column">
      {accounts.length === 0 ? (
        <Box marginTop={1}>
          <Text color="gray">No accounts yet. Press 'a' to add one.</Text>
        </Box>
      ) : (
        accounts.map((view, idx) => {
          const isSelected = idx === selectedIndex;
          const isDefault = state.default_account === view.account.name;
          const autoSwap = view.account.auto_swap;
          const nameColor = !view.loggedIn || view.needsRelogin ? "red" : autoSwap ? "green" : "gray";
          const suffix = !autoSwap ? " (off)" : "";
          const markerBg = isSelected ? "magenta" : undefined;
          const defaultLabel = isDefault ? "★ yes" : "·";
          const defaultColor = isDefault ? "yellow" : "gray";

          return (
            <Box
              key={view.account.name}
              flexDirection="row"
            >
              <Box width={columns[0]!.width} marginRight={1}>
                <Text backgroundColor={markerBg}> </Text>
              </Box>
              <Box width={columns[1]!.width} marginRight={1}>
                <Text color={defaultColor} bold={isDefault}>{fitText(defaultLabel, columns[1]!.width)}</Text>
              </Box>
              <Box width={columns[2]!.width} marginRight={1}>
                <Text color={nameColor} bold={isSelected} dimColor={!autoSwap}>
                  {fitText((view.account.email ?? view.account.name) + suffix, columns[2]!.width)}
                </Text>
              </Box>
              <Box width={columns[3]!.width} marginRight={1}>
                <Text color="gray">{fitText(view.subscriptionType ?? "-", columns[3]!.width)}</Text>
              </Box>
              <Box width={columns[4]!.width} marginRight={1}>
                {view.needsRelogin ? (
                  <Text color="red">re-login</Text>
                ) : view.loggedIn ? (
                  <UsageBar percent={view.usage.five_hour_pct} width={usageBarWidth(columns[4]!.width)} />
                ) : (
                  <Text color="red">login needed</Text>
                )}
              </Box>
              <Box width={columns[5]!.width} marginRight={1}>
                {view.needsRelogin ? (
                  <Text color="red">required</Text>
                ) : view.loggedIn ? (
                  <UsageBar percent={view.usage.seven_day_pct} width={usageBarWidth(columns[5]!.width)} />
                ) : (
                  <Text color="red">login needed</Text>
                )}
              </Box>
              <Box width={columns[6]!.width}>
                <Text color="gray">{fitText(formatAgo(view.usage.cache_timestamp_ms) || "--", columns[6]!.width)}</Text>
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
      {selected ? (() => {
        const eligible = accounts.filter((v) => v.account.auto_swap && v.loggedIn && !v.needsRelogin);
        const eligibleRank = eligible.findIndex((v) => v.account.name === selected.account.name);
        const swapStatus = !selected.loggedIn
          ? "excluded · login needed"
          : selected.needsRelogin
          ? "excluded · re-login required"
          : !selected.account.auto_swap
          ? "excluded · auto-swap off"
          : eligibleRank >= 0
          ? `eligible · #${eligibleRank + 1} of ${eligible.length} ready`
          : "eligible";
        const credential = `${credentialStoreLabel(platform())} · ${selected.account.keychain_service}`;
        const fiveRel = formatRelativeFromNow(selected.usage.five_hour_reset_at);
        const sevenRel = formatRelativeFromNow(selected.usage.seven_day_reset_at);
        const cachedClock = formatUpdatedAt(selected.usage.cache_timestamp_ms);
        const cachedAgo = formatAgo(selected.usage.cache_timestamp_ms);
        const thresholdLabel = thresholdPct === null ? "disabled" : `${thresholdPct}%`;
        return (
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text color="gray" bold>Status      </Text>
              <Text color="gray">
                {[
                  state.default_account === selected.account.name ? "Default" : "Not default",
                  selected.account.auto_swap ? "auto-swap on" : "auto-swap off",
                  `plan ${selected.subscriptionType ?? "-"}`,
                  selected.needsRelogin ? "re-login required" : selected.loggedIn ? "logged in" : "no login",
                ].join(" · ")}
              </Text>
            </Text>
            {selected.needsRelogin ? (
              <Text>
                <Text color="gray" bold>Auth issue  </Text>
                <Text color="red">{selected.account.auth_error_reason ?? "re-login required"}</Text>
              </Text>
            ) : null}
            <Text>
              <Text color="gray" bold>Email       </Text>
              <Text color="gray">{selected.account.email ?? "- (re-login to populate)"}</Text>
            </Text>
            <Text>
              <Text color="gray" bold>Swap queue  </Text>
              <Text color="gray">{swapStatus}</Text>
            </Text>
            <Text>
              <Text color="gray" bold>Threshold   </Text>
              <Text color="gray">{thresholdLabel}</Text>
            </Text>
            <Text>
              <Text color="gray" bold>Credential  </Text>
              <Text color="gray">{credential}</Text>
            </Text>
            <Text>
              <Text color="gray">5h  </Text>
              <UsageBar percent={selected.usage.five_hour_pct} width={18} />
              <Text color="gray">   resets {formatIsoLocal(selected.usage.five_hour_reset_at)}{fiveRel ? `  ${fiveRel}` : ""}</Text>
            </Text>
            <Text>
              <Text color="gray">7d  </Text>
              <UsageBar percent={selected.usage.seven_day_pct} width={18} />
              <Text color="gray">   resets {formatIsoLocal(selected.usage.seven_day_reset_at)}{sevenRel ? `  ${sevenRel}` : ""}  ·  cached {cachedClock}{cachedAgo ? ` (${cachedAgo})` : ""}</Text>
            </Text>
          </Box>
        );
      })() : (
        <Text color="gray">No account selected.</Text>
      )}
    </Box>
  );
}
