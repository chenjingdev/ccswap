import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (isNotFound(err)) return fallback;
    throw err;
  }
}

export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  if (platform() !== "win32") {
    chmodSync(path, 0o600);
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
