import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";

export interface InputModalProps {
  title: string;
  placeholder?: string;
  initialValue?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function InputModal({
  title,
  placeholder,
  initialValue = "",
  onSubmit,
  onCancel,
}: InputModalProps) {
  const [value, setValue] = useState<string>(initialValue);

  useInput((_input, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box borderStyle="round" borderColor="cyan" flexDirection="column" padding={1}>
      <Text bold>{title}</Text>
      <Box marginTop={1}>
        <Text color="gray">&gt; </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(v: string) => onSubmit(v.trim())}
          placeholder={placeholder}
        />
      </Box>
      <Text color="gray">Enter: confirm · Esc: cancel</Text>
    </Box>
  );
}
