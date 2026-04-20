import { Box, Text, useInput } from "ink";

export interface EditAccountMenuProps {
  name: string;
  autoSwap: boolean;
  onRename: () => void;
  onToggleAutoSwap: () => void;
  onDelete: () => void;
  onCancel: () => void;
}

export function EditAccountMenu({
  name,
  autoSwap,
  onRename,
  onToggleAutoSwap,
  onDelete,
  onCancel,
}: EditAccountMenuProps) {
  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (input === "r" || input === "R") onRename();
    else if (input === "t" || input === "T") onToggleAutoSwap();
    else if (input === "d" || input === "D") onDelete();
  });

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" padding={1}>
      <Text bold>Edit '{name}'</Text>
      <Box marginTop={1} flexDirection="column">
        <Text><Text color="cyan">r</Text> Rename</Text>
        <Text>
          <Text color="cyan">t</Text> Toggle auto-swap{" "}
          <Text color="gray">(currently {autoSwap ? "on" : "off"})</Text>
        </Text>
        <Text><Text color="red">d</Text> Delete account</Text>
      </Box>
      <Text color="gray">Esc: cancel</Text>
    </Box>
  );
}
