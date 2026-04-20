import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadUsageCache,
  parseUsageCache,
  readUsageCacheState,
  refreshUsageCache,
  usagePlanName,
  usingCustomApiEndpoint,
} from "../src/core/usage.js";

function writeCache(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

describe("usagePlanName", () => {
  it("maps subscription strings to plan name", () => {
    expect(usagePlanName("max")).toBe("Max");
    expect(usagePlanName("claude_max")).toBe("Max");
    expect(usagePlanName("pro")).toBe("Pro");
    expect(usagePlanName("team_plan")).toBe("Team");
    expect(usagePlanName("enterprise")).toBe("Enterprise");
  });

  it("returns null for api/empty", () => {
    expect(usagePlanName("api")).toBeNull();
    expect(usagePlanName("")).toBeNull();
    expect(usagePlanName(null)).toBeNull();
  });
});

describe("usingCustomApiEndpoint", () => {
  it("detects default endpoint as non-custom", () => {
    expect(usingCustomApiEndpoint({})).toBe(false);
    expect(usingCustomApiEndpoint({ ANTHROPIC_BASE_URL: "" })).toBe(false);
    expect(
      usingCustomApiEndpoint({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }),
    ).toBe(false);
  });

  it("detects proxies and custom bases", () => {
    expect(
      usingCustomApiEndpoint({ ANTHROPIC_BASE_URL: "http://localhost:8080" }),
    ).toBe(true);
    expect(
      usingCustomApiEndpoint({ ANTHROPIC_API_BASE_URL: "https://proxy.example/anthropic" }),
    ).toBe(true);
    expect(usingCustomApiEndpoint({ ANTHROPIC_BASE_URL: "not a url" })).toBe(true);
  });
});

describe("parseUsageCache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccswap-usage-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads fresh data payload", () => {
    const path = join(tmp, "c.json");
    writeCache(path, {
      data: { planName: "Max", fiveHour: 50, sevenDay: 30, fiveHourResetAt: "2026-04-20T00:00:00Z" },
      timestamp: 1710000000000,
    });
    const snap = parseUsageCache(path);
    expect(snap.plan_name).toBe("Max");
    expect(snap.five_hour_pct).toBe(50);
    expect(snap.seven_day_pct).toBe(30);
    expect(snap.cache_timestamp_ms).toBe(1710000000000);
    expect(snap.five_hour_reset_at).toBe("2026-04-20T00:00:00Z");
  });

  it("falls back to lastGoodData when rate-limited", () => {
    const path = join(tmp, "c.json");
    writeCache(path, {
      data: { apiError: "rate-limited", apiUnavailable: true },
      lastGoodData: { planName: "Pro", fiveHour: 42, sevenDay: 10 },
      timestamp: 1710000000000,
    });
    const snap = parseUsageCache(path);
    expect(snap.plan_name).toBe("Pro");
    expect(snap.five_hour_pct).toBe(42);
  });

  it("returns empty snapshot for missing file", () => {
    const snap = loadUsageCache(join(tmp, "missing.json"));
    expect(snap.plan_name).toBeNull();
    expect(snap.five_hour_pct).toBeNull();
  });

  it("fresh TTL within 5 minutes", () => {
    const path = join(tmp, "c.json");
    const now = Date.now();
    writeCache(path, {
      data: { planName: "Max", fiveHour: 20, sevenDay: 15 },
      timestamp: now,
    });
    const state = readUsageCacheState(path, now + 60_000);
    expect(state?.fresh).toBe(true);
    const stale = readUsageCacheState(path, now + 6 * 60_000);
    expect(stale?.fresh).toBe(false);
  });

  it("clamps percent to [0,100]", () => {
    const path = join(tmp, "c.json");
    writeCache(path, {
      data: { planName: "Max", fiveHour: 117.6, sevenDay: -3 },
      timestamp: Date.now(),
    });
    const snap = parseUsageCache(path);
    expect(snap.five_hour_pct).toBe(100);
    expect(snap.seven_day_pct).toBe(0);
  });
});

describe("refreshUsageCache (mocked fetch)", () => {
  let tmp: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccswap-usage-api-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  it("stores percent buckets from a successful response", async () => {
    const cache = join(tmp, "c.json");
    const lock = join(tmp, "c.json.lock");
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 87, resets_at: "2026-04-20T05:00:00Z" },
          seven_day: { utilization: 12, resets_at: "2026-04-27T05:00:00Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const ok = await refreshUsageCache(cache, lock, "token-123", "max", { force: true, env: {} });
    expect(ok).toBe(true);
    const snap = loadUsageCache(cache);
    expect(snap.plan_name).toBe("Max");
    expect(snap.five_hour_pct).toBe(87);
    expect(snap.seven_day_pct).toBe(12);
  });

  it("marks apiUnavailable on HTTP 429 and keeps lastGoodData", async () => {
    const cache = join(tmp, "c.json");
    const lock = join(tmp, "c.json.lock");

    // Seed with a previous success
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 50 },
          seven_day: { utilization: 10 },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    await refreshUsageCache(cache, lock, "t", "max", { force: true, env: {} });

    // Now 429
    globalThis.fetch = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "60" },
        }),
    ) as unknown as typeof fetch;
    const ok = await refreshUsageCache(cache, lock, "t", "max", { force: true, env: {} });
    expect(ok).toBe(true); // lastGood still available
    const snap = loadUsageCache(cache);
    // Snapshot falls back to last good
    expect(snap.five_hour_pct).toBe(50);
  });

  it("skips API when ANTHROPIC_BASE_URL points to a proxy", async () => {
    const cache = join(tmp, "c.json");
    const lock = join(tmp, "c.json.lock");
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const ok = await refreshUsageCache(cache, lock, "token", "max", {
      force: true,
      env: { ANTHROPIC_BASE_URL: "http://localhost:8080" },
    });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("short-circuits when cache is still fresh (no fetch, no lock)", async () => {
    const cache = join(tmp, "c.json");
    const lock = join(tmp, "c.json.lock");
    writeFileSync(
      cache,
      JSON.stringify({
        data: { planName: "Max", fiveHour: 20, sevenDay: 10 },
        timestamp: Date.now(),
      }),
    );
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const ok = await refreshUsageCache(cache, lock, "token", "max", { env: {} });
    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
