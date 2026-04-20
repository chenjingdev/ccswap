import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

export interface EditAccountMenuProps {
  name: string;
  autoSwap: boolean;
  onRename: () => void;
  onToggleAutoSwap: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

type Action = "rename" | "toggle" | "delete";

export function EditAccountMenu({
  name,
  autoSwap,
  onRename,
  onToggleAutoSwap,
  onDelete,
  onCancel,
}: EditAccountMenuProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const items = [
    { label: "Rename", value: "rename" as Action },
    { label: `Toggle auto-swap  (currently ${autoSwap ? "on" : "off"})`, value: "toggle" as Action },
    { label: "Delete account", value: "delete" as Action },
  ];

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>Edit '{name}'</Text>
      <Box marginTop={1}>
        <SelectInput<Action>
          items={items}
          onSelect={(item) => {
            if (item.value === "rename") onRename();
            else if (item.value === "toggle") onToggleAutoSwap();
            else if (item.value === "delete") onDelete();
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate · Enter confirm · Esc cancel</Text>
      </Box>
    </Box>
  );
}
