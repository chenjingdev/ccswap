import { Text } from "ink";

interface Props {
  percent: number | null;
  width: number;
}

function barColor(percent: number): "green" | "yellow" | "red" {
  if (percent >= 85) return "red";
  if (percent >= 60) return "yellow";
  return "green";
}

export function UsageBar({ percent, width }: Props) {
  if (percent === null) {
    return (
      <>
        <Text color="gray">{"░".repeat(width)}</Text>
        <Text color="gray"> --</Text>
      </>
    );
  }
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  const empty = width - filled;
  const color = barColor(percent);
  const label = ` ${String(percent).padStart(3)}%`;
  return (
    <>
      <Text color={color}>{"▇".repeat(filled)}</Text>
      <Text color="gray">{"░".repeat(empty)}</Text>
      <Text color={color}>{label}</Text>
    </>
  );
}
