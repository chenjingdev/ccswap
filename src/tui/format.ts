export function fitText(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value.padEnd(width);
  if (width === 1) return value.slice(0, 1);
  return value.slice(0, width - 1) + "…";
}

export function replayLabel(mode: string): string {
  switch (mode) {
    case "last_prompt":
      return "Last prompt";
    case "continue":
      return "Continue only";
    case "custom_prompt":
      return "Custom prompt";
    default:
      return mode;
  }
}

export function formatIsoLocal(iso: string | null): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function formatUpdatedAt(timestampMs: number | null): string {
  if (!timestampMs) return "--";
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return "--";
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mi}:${ss}`;
}
