import { Box, Text, useInput } from "ink";

export interface ConfirmModalProps {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, message, onConfirm, onCancel }: ConfirmModalProps) {
  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") onCancel();
    if (key.return || input === "y" || input === "Y") onConfirm();
  });

  return (
    <Box borderStyle="round" borderColor="yellow" flexDirection="column" padding={1}>
      <Text bold color="yellow">{title}</Text>
      <Box marginTop={1}>
        <Text>{message}</Text>
      </Box>
      <Text color="gray">y: confirm · n/Esc: cancel</Text>
    </Box>
  );
}
