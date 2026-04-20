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

export function formatRelativeFromNow(iso: string | null): string {
  if (!iso) return "";
  const target = new Date(iso);
  const diff = target.getTime() - Date.now();
  if (Number.isNaN(diff)) return "";
  const abs = Math.abs(diff);
  const mins = Math.max(1, Math.floor(abs / 60_000));
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);
  let text: string;
  if (days >= 1) {
    const rem = hours % 24;
    text = rem ? `${days}d ${rem}h` : `${days}d`;
  } else if (hours >= 1) {
    const rem = mins % 60;
    text = rem ? `${hours}h ${rem}m` : `${hours}h`;
  } else {
    text = `${mins}m`;
  }
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

export function formatAgo(timestampMs: number | null): string {
  if (!timestampMs) return "";
  const diff = Date.now() - timestampMs;
  if (diff < 0 || Number.isNaN(diff)) return "";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

export function credentialStoreLabel(platformName: string): string {
  if (platformName === "darwin") return "macOS Keychain";
  if (platformName === "win32") return "Windows Credential Manager";
  return "Secret Service";
}
