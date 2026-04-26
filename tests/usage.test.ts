import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadUsageCache,
  captureStatusLineUsage,
  parseUsageCache,
  readUsageCacheState,
  refreshUsageCache,
  usageCredentialFingerprint,
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
      data: { planName: "Max", fiveHour: 50, sevenDay: 30, fiveHourResetAt: "2999-04-20T00:00:00Z" },
      timestamp: 1710000000000,
    });
    const snap = parseUsageCache(path);
    expect(snap.plan_name).toBe("Max");
    expect(snap.five_hour_pct).toBe(50);
    expect(snap.seven_day_pct).toBe(30);
    expect(snap.cache_timestamp_ms).toBe(1710000000000);
    expect(snap.five_hour_reset_at).toBe("2999-04-20T00:00:00Z");
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

  it("ignores cache data written for a different access token", () => {
    const path = join(tmp, "c.json");
    writeCache(path, {
      data: { planName: "Max", fiveHour: 20, sevenDay: 15 },
      timestamp: 1710000000000,
      credentialFingerprint: usageCredentialFingerprint("token-a"),
    });
    const snap = loadUsageCache(path, { accessToken: "token-b", subscriptionType: "max" });
    expect(snap.plan_name).toBeNull();
    expect(snap.five_hour_pct).toBeNull();
  });

  it("ignores legacy cache data whose plan does not match the credential", () => {
    const path = join(tmp, "c.json");
    writeCache(path, {
      data: { planName: "Max", fiveHour: 20, sevenDay: 15 },
      timestamp: 1710000000000,
    });
    const snap = loadUsageCache(path, { accessToken: "team-token", subscriptionType: "team" });
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

  it("treats recent statusline captures as fresh", () => {
    const path = join(tmp, "c.json");
    const now = Date.now();
    writeCache(path, {
      data: { source: "statusline", planName: "Max", fiveHour: 20, sevenDay: 15 },
      timestamp: now,
    });
    expect(readUsageCacheState(path, now + 4 * 60_000)?.fresh).toBe(true);
    expect(readUsageCacheState(path, now + 6 * 60_000)?.fresh).toBe(false);
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

  it("drops buckets whose reset time has already passed", () => {
    const path = join(tmp, "c.json");
    writeCache(path, {
      data: {
        planName: "Max",
        fiveHour: 88,
        sevenDay: 70,
        fiveHourResetAt: "2999-04-20T00:00:00Z",
        sevenDayResetAt: "2000-04-20T00:00:00Z",
      },
      timestamp: Date.now(),
    });
    const snap = parseUsageCache(path);
    expect(snap.five_hour_pct).toBe(88);
    expect(snap.five_hour_reset_at).toBe("2999-04-20T00:00:00Z");
    expect(snap.seven_day_pct).toBeNull();
    expect(snap.seven_day_reset_at).toBeNull();
  });

  it("drops expired lastGoodData buckets when rate-limited", () => {
    const path = join(tmp, "c.json");
    writeCache(path, {
      data: { apiError: "rate-limited", apiUnavailable: true },
      lastGoodData: {
        planName: "Max",
        fiveHour: 0,
        sevenDay: 70,
        sevenDayResetAt: "2000-04-20T00:00:00Z",
      },
      timestamp: Date.now(),
    });
    const snap = parseUsageCache(path);
    expect(snap.five_hour_pct).toBe(0);
    expect(snap.seven_day_pct).toBeNull();
    expect(snap.seven_day_reset_at).toBeNull();
  });

  it("captures Claude Code statusline rate limits", () => {
    const path = join(tmp, "c.json");
    const ok = captureStatusLineUsage(
      path,
      "Max",
      {
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 32503680000 },
          seven_day: { used_percentage: 41.2, resets_at: 32503766400 },
        },
      },
      1710000000000,
      usageCredentialFingerprint("token-123"),
    );
    expect(ok).toBe(true);
    const snap = parseUsageCache(path);
    expect(snap.plan_name).toBe("Max");
    expect(snap.five_hour_pct).toBe(24);
    expect(snap.seven_day_pct).toBe(41);
    expect(snap.cache_timestamp_ms).toBe(1710000000000);
    expect(snap.five_hour_reset_at).toBe("3000-01-01T00:00:00.000Z");
    const state = readUsageCacheState(path, 1710000000000 + 60_000);
    expect(state?.fresh).toBe(true);
    expect(readUsageCacheState(path, 1710000000000 + 60_000, { accessToken: "other-token" })).toBeNull();
  });

  it("ignores statusline input without rate limits", () => {
    const path = join(tmp, "c.json");
    const ok = captureStatusLineUsage(path, "Max", {}, 1710000000000);
    expect(ok).toBe(false);
    expect(loadUsageCache(path).cache_timestamp_ms).toBeNull();
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
          five_hour: { utilization: 87, resets_at: "2999-04-20T05:00:00Z" },
          seven_day: { utilization: 12, resets_at: "2999-04-27T05:00:00Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const ok = await refreshUsageCache(cache, lock, "token-123", "max", { force: true, env: {} });
    expect(ok).toBe(true);
    const raw = JSON.parse(readFileSync(cache, "utf-8")) as {
      credentialFingerprint?: string;
    };
    expect(raw.credentialFingerprint).toBe(usageCredentialFingerprint("token-123"));
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
