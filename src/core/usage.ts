import {
  chmodSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import type { AccountData } from "./config.js";
import { getAccountCredential, parseStoredCredential } from "./credentials.js";
import { ensureDir } from "./fs-util.js";
import { USAGE_CACHE_DIR } from "./paths.js";

const USAGE_CACHE_TTL_MS = 5 * 60_000;
const USAGE_FAILURE_TTL_MS = 15_000;
const USAGE_RATE_LIMITED_BASE_MS = 60_000;
const USAGE_RATE_LIMITED_MAX_MS = 5 * 60_000;
const USAGE_CACHE_LOCK_STALE_MS = 30_000;
const USAGE_CACHE_LOCK_WAIT_MS = 2_000;
const USAGE_CACHE_LOCK_POLL_MS = 50;
const USAGE_API_TIMEOUT_MS = 15_000;

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const USAGE_BETA_HEADER = "oauth-2025-04-20";
const USAGE_USER_AGENT = "claude-code/2.1";

export interface UsageSnapshot {
  plan_name: string | null;
  five_hour_pct: number | null;
  seven_day_pct: number | null;
  five_hour_reset_at: string | null;
  seven_day_reset_at: string | null;
  cache_timestamp_ms: number | null;
}

function emptySnapshot(): UsageSnapshot {
  return {
    plan_name: null,
    five_hour_pct: null,
    seven_day_pct: null,
    five_hour_reset_at: null,
    seven_day_reset_at: null,
    cache_timestamp_ms: null,
  };
}

interface UsageData {
  planName?: string | null;
  fiveHour?: number | null;
  sevenDay?: number | null;
  fiveHourResetAt?: string | null;
  sevenDayResetAt?: string | null;
  apiUnavailable?: boolean;
  apiError?: string;
}

interface UsageCacheFile {
  data?: UsageData;
  timestamp?: number;
  rateLimitedCount?: number;
  retryAfterUntil?: number;
  lastGoodData?: UsageData;
}

export function accountUsageCachePath(account: AccountData): string {
  ensureDir(USAGE_CACHE_DIR);
  const key = account.name.replace(/[^A-Za-z0-9._-]+/g, "-") || "account";
  return join(USAGE_CACHE_DIR, `${key}.json`);
}

function accountUsageLockPath(account: AccountData): string {
  return `${accountUsageCachePath(account)}.lock`;
}

function coercePercent(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function coerceDate(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function readCacheFile(path: string): UsageCacheFile | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UsageCacheFile)
      : null;
  } catch {
    return null;
  }
}

function snapshotFromPayload(payload: UsageData | undefined, timestamp: number | null): UsageSnapshot {
  if (!payload) return { ...emptySnapshot(), cache_timestamp_ms: timestamp };
  return {
    plan_name: payload.planName ?? null,
    five_hour_pct: coercePercent(payload.fiveHour),
    seven_day_pct: coercePercent(payload.sevenDay),
    five_hour_reset_at: coerceDate(payload.fiveHourResetAt),
    seven_day_reset_at: coerceDate(payload.sevenDayResetAt),
    cache_timestamp_ms: timestamp,
  };
}

export function parseUsageCache(path: string): UsageSnapshot {
  const raw = readCacheFile(path);
  if (!raw) return emptySnapshot();
  const data = raw.data ?? null;
  const lastGood = raw.lastGoodData ?? null;
  let payload: UsageData | null;
  if (data && data.apiError === "rate-limited" && lastGood) {
    payload = lastGood;
  } else if (!data && lastGood) {
    payload = lastGood;
  } else {
    payload = data;
  }
  const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : null;
  return snapshotFromPayload(payload ?? undefined, timestamp);
}

export function loadUsageCache(path: string): UsageSnapshot {
  if (!existsSync(path)) return emptySnapshot();
  return parseUsageCache(path);
}

function usageRetryUntil(raw: UsageCacheFile): number | null {
  if (!raw.data || raw.data.apiError !== "rate-limited") return null;
  const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : 0;
  if (typeof raw.retryAfterUntil === "number" && raw.retryAfterUntil > timestamp) {
    return raw.retryAfterUntil;
  }
  const count = typeof raw.rateLimitedCount === "number" ? raw.rateLimitedCount : 0;
  if (count <= 0) return null;
  const delay = Math.min(
    USAGE_RATE_LIMITED_BASE_MS * 2 ** Math.max(0, count - 1),
    USAGE_RATE_LIMITED_MAX_MS,
  );
  return timestamp + delay;
}

export function readUsageCacheState(
  cachePath: string,
  nowMs: number,
): { snapshot: UsageSnapshot; fresh: boolean } | null {
  const raw = readCacheFile(cachePath);
  if (!raw) return null;
  const snapshot = parseUsageCache(cachePath);
  const retryUntil = usageRetryUntil(raw);
  if (retryUntil !== null && nowMs < retryUntil) {
    return { snapshot, fresh: true };
  }
  const ttlMs = raw.data?.apiUnavailable ? USAGE_FAILURE_TTL_MS : USAGE_CACHE_TTL_MS;
  const timestamp = snapshot.cache_timestamp_ms;
  if (timestamp === null) return { snapshot, fresh: false };
  return { snapshot, fresh: nowMs - timestamp < ttlMs };
}

function readLastGood(cachePath: string): UsageData | null {
  const raw = readCacheFile(cachePath);
  if (!raw) return null;
  return raw.lastGoodData ?? null;
}

function readCachedPlanName(cachePath: string): string | null {
  const raw = readCacheFile(cachePath);
  if (!raw) return null;
  if (raw.data?.planName) return raw.data.planName;
  if (raw.lastGoodData?.planName) return raw.lastGoodData.planName;
  return null;
}

function writeCacheFile(cachePath: string, payload: UsageCacheFile): void {
  ensureDir(USAGE_CACHE_DIR);
  writeFileSync(cachePath, JSON.stringify(payload) + "\n", { encoding: "utf-8", mode: 0o600 });
  if (platform() !== "win32") {
    try {
      chmodSync(cachePath, 0o600);
    } catch {
      // ignore
    }
  }
}

type LockStatus = "acquired" | "busy" | "unsupported";

function tryAcquireLock(lockPath: string): LockStatus {
  ensureDir(USAGE_CACHE_DIR);
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      writeSync(fd, String(Date.now()));
    } finally {
      closeSync(fd);
    }
    return "acquired";
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== "EEXIST") return "unsupported";
  }

  const now = Date.now();
  let lockTs: number | null = null;
  try {
    lockTs = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    if (Number.isNaN(lockTs)) lockTs = null;
  } catch {
    lockTs = null;
  }
  if (lockTs === null) {
    try {
      if (now - statSync(lockPath).mtimeMs < USAGE_CACHE_LOCK_STALE_MS) return "busy";
    } catch {
      return tryAcquireLock(lockPath);
    }
  } else if (now - lockTs < USAGE_CACHE_LOCK_STALE_MS) {
    return "busy";
  }

  try {
    rmSync(lockPath, { force: true });
  } catch {
    return "busy";
  }
  return tryAcquireLock(lockPath);
}

function releaseLock(lockPath: string): void {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // ignore
  }
}

async function waitForFreshCache(cachePath: string, lockPath: string): Promise<UsageSnapshot | null> {
  const deadline = Date.now() + USAGE_CACHE_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(USAGE_CACHE_LOCK_POLL_MS);
    const state = readUsageCacheState(cachePath, Date.now());
    if (state?.fresh) return state.snapshot;
    if (!existsSync(lockPath)) break;
  }
  const final = readUsageCacheState(cachePath, Date.now());
  return final?.snapshot ?? null;
}

export function usagePlanName(subscriptionType: string | null | undefined): string | null {
  const value = (subscriptionType ?? "").trim();
  const lower = value.toLowerCase();
  if (lower.includes("max")) return "Max";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("team")) return "Team";
  if (!value || lower.includes("api")) return null;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function usingCustomApiEndpoint(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env["ANTHROPIC_BASE_URL"] ?? env["ANTHROPIC_API_BASE_URL"] ?? "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}` !== "https://api.anthropic.com";
  } catch {
    return true;
  }
}

interface ApiResult {
  data: Record<string, unknown> | null;
  error: string | null;
  retryAfterSeconds: number | null;
}

async function fetchUsageApi(accessToken: string): Promise<ApiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), USAGE_API_TIMEOUT_MS);
  try {
    const response = await fetch(USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": USAGE_BETA_HEADER,
        "User-Agent": USAGE_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = response.status === 429 ? "rate-limited" : `http-${response.status}`;
      const retryAfter = parseRetryAfterSeconds(response.headers.get("Retry-After"));
      return { data: null, error, retryAfterSeconds: retryAfter };
    }
    const json = (await response.json()) as unknown;
    if (json && typeof json === "object" && !Array.isArray(json)) {
      return { data: json as Record<string, unknown>, error: null, retryAfterSeconds: null };
    }
    return { data: null, error: "shape", retryAfterSeconds: null };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "AbortError") return { data: null, error: "timeout", retryAfterSeconds: null };
    return { data: null, error: "network", retryAfterSeconds: null };
  } finally {
    clearTimeout(timer);
  }
}

function readUtilization(payload: Record<string, unknown>, key: string): { pct: number | null; resetAt: string | null } {
  const bucket = payload[key];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
    return { pct: null, resetAt: null };
  }
  const bucketRec = bucket as Record<string, unknown>;
  return {
    pct: coercePercent(bucketRec["utilization"]),
    resetAt: coerceDate(bucketRec["resets_at"]),
  };
}

export async function refreshUsageCache(
  cachePath: string,
  lockPath: string,
  accessToken: string,
  subscriptionType: string,
  options: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  const { force = false, env = process.env } = options;
  if (!accessToken || usingCustomApiEndpoint(env)) return false;

  let state = force ? null : readUsageCacheState(cachePath, Date.now());
  if (state?.fresh) return true;
  if (force) state = readUsageCacheState(cachePath, Date.now());

  const lockStatus = tryAcquireLock(lockPath);
  if (lockStatus === "busy") {
    if (state) return true;
    return (await waitForFreshCache(cachePath, lockPath)) !== null;
  }
  const holdsLock = lockStatus === "acquired";

  try {
    if (!force) {
      const refreshed = readUsageCacheState(cachePath, Date.now());
      if (refreshed?.fresh) return true;
    }

    let planName = usagePlanName(subscriptionType);
    if (!planName && !subscriptionType.trim()) {
      planName = readCachedPlanName(cachePath);
    }
    if (!planName) return false;

    const apiResult = await fetchUsageApi(accessToken);
    const now = Date.now();

    if (apiResult.data === null) {
      const isRateLimited = apiResult.error === "rate-limited";
      const prev = readCacheFile(cachePath);
      const prevCount = typeof prev?.rateLimitedCount === "number" ? prev.rateLimitedCount : 0;
      const rateLimitedCount = isRateLimited ? prevCount + 1 : 0;
      const retryAfterUntil = isRateLimited && apiResult.retryAfterSeconds
        ? now + apiResult.retryAfterSeconds * 1000
        : undefined;
      const failureResult: UsageData = {
        planName,
        fiveHour: null,
        sevenDay: null,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        apiUnavailable: true,
        apiError: apiResult.error ?? "unknown",
      };
      const lastGood = readLastGood(cachePath);
      const payload: UsageCacheFile = {
        data: failureResult,
        timestamp: now,
      };
      if (isRateLimited && rateLimitedCount > 0) payload.rateLimitedCount = rateLimitedCount;
      if (retryAfterUntil !== undefined) payload.retryAfterUntil = retryAfterUntil;
      if (lastGood) payload.lastGoodData = lastGood;
      writeCacheFile(cachePath, payload);
      return lastGood !== null || !isRateLimited;
    }

    const fiveHour = readUtilization(apiResult.data, "five_hour");
    const sevenDay = readUtilization(apiResult.data, "seven_day");
    const result: UsageData = {
      planName,
      fiveHour: fiveHour.pct,
      sevenDay: sevenDay.pct,
      fiveHourResetAt: fiveHour.resetAt,
      sevenDayResetAt: sevenDay.resetAt,
    };
    writeCacheFile(cachePath, { data: result, timestamp: now, lastGoodData: result });
    return true;
  } finally {
    if (holdsLock) releaseLock(lockPath);
  }
}

export async function refreshAccountUsage(account: AccountData, force = false): Promise<boolean> {
  const credential = getAccountCredential(account);
  if (!credential) return false;
  const parsed = parseStoredCredential(credential.secret);
  const accessToken = parsed.access_token ?? "";
  const subscriptionType = parsed.subscription_type ?? "";
  return await refreshUsageCache(
    accountUsageCachePath(account),
    accountUsageLockPath(account),
    accessToken,
    subscriptionType,
    { force },
  );
}

export async function isAccountUsageExhausted(account: AccountData, forceRefresh = false): Promise<boolean> {
  if (forceRefresh) await refreshAccountUsage(account, true);
  const snapshot = loadUsageCache(accountUsageCachePath(account));
  return snapshot.five_hour_pct === 100 || snapshot.seven_day_pct === 100;
}
