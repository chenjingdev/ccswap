import { Box, Text } from "ink";

import type { AppStateData } from "../../core/state.js";
import type { AccountView } from "../useConfigState.js";

interface Props {
  accounts: AccountView[];
  state: AppStateData;
  selectedIndex: number;
}

function statusLabel(view: AccountView): { text: string; color: string } {
  if (view.loggedIn) {
    const sub = view.subscriptionType ? ` · ${view.subscriptionType}` : "";
    return { text: `logged in${sub}`, color: "green" };
  }
  return { text: "no login", color: "red" };
}

export function AccountsScreen({ accounts, state, selectedIndex }: Props) {
  if (accounts.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">No accounts yet. Press [a] to add one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Box width={3}><Text bold> </Text></Box>
        <Box width={22}><Text bold underline>Name</Text></Box>
        <Box width={22}><Text bold underline>Status</Text></Box>
        <Box width={14}><Text bold underline>Auto-swap</Text></Box>
      </Box>
      {accounts.map((view, idx) => {
        const isSelected = idx === selectedIndex;
        const isActive = state.active_account === view.account.name;
        const status = statusLabel(view);
        const row = (
          <Box paddingX={1}>
            <Box width={3}>
              <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "›" : " "}</Text>
            </Box>
            <Box width={22}>
              <Text color={isActive ? "cyan" : undefined} bold={isActive}>
                {isActive ? "★ " : "  "}
                {view.account.name}
              </Text>
            </Box>
            <Box width={22}>
              <Text color={status.color}>{status.text}</Text>
            </Box>
            <Box width={14}>
              <Text color={view.account.auto_swap ? "green" : "gray"}>
                {view.account.auto_swap ? "enabled" : "disabled"}
              </Text>
            </Box>
          </Box>
        );
        return (
          <Box key={view.account.name} flexDirection="row">
            {isSelected ? (
              <Box backgroundColor="gray" width="100%">
                {row}
              </Box>
            ) : (
              row
            )}
          </Box>
        );
      })}
    </Box>
  );
}
