import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

export interface ConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

type Answer = "no" | "yes";

export function ConfirmModal({ title, message, onConfirm, onCancel }: ConfirmModalProps) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  const items = [
    { label: "Cancel", value: "no" as Answer },
    { label: "Confirm", value: "yes" as Answer },
  ];

  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="yellow">{title}</Text>
      <Box marginTop={1}>
        <Text>{message}</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput<Answer>
          items={items}
          onSelect={(item) => (item.value === "yes" ? onConfirm() : onCancel())}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate · Enter confirm · Esc cancel</Text>
      </Box>
    </Box>
  );
}
