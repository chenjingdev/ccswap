from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

USAGE_CACHE_TTL_MS = 5 * 60_000
USAGE_FAILURE_TTL_MS = 15_000
USAGE_RATE_LIMITED_BASE_MS = 60_000
USAGE_RATE_LIMITED_MAX_MS = 5 * 60_000
USAGE_CACHE_LOCK_STALE_MS = 30_000
USAGE_CACHE_LOCK_WAIT_MS = 2_000
USAGE_CACHE_LOCK_POLL_MS = 0.05
USAGE_API_TIMEOUT_SECONDS = 15


@dataclass
class UsageSnapshot:
    plan_name: str | None = None
    five_hour_pct: int | None = None
    seven_day_pct: int | None = None
    context_pct: int | None = None
    five_hour_reset_at: str | None = None
    seven_day_reset_at: str | None = None
    cache_timestamp_ms: int | None = None


def _load_json(path: Path, default: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _coerce_percent(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value:
        return None
    return max(0, min(100, int(round(float(value)))))


def _parse_usage_cache_date(value: object) -> str | None:
    return str(value) if isinstance(value, str) and value else None


def parse_usage_cache(path: Path) -> UsageSnapshot:
    raw = _load_json(path, {})
    if not isinstance(raw, dict):
        return UsageSnapshot()
    data = raw.get("data")
    last_good = raw.get("lastGoodData")
    if isinstance(data, dict) and data.get("apiError") == "rate-limited" and isinstance(last_good, dict):
        payload = last_good
    elif isinstance(last_good, dict) and not isinstance(data, dict):
        payload = last_good
    else:
        payload = data if isinstance(data, dict) else {}
    return UsageSnapshot(
        plan_name=str(payload.get("planName")) if payload.get("planName") else None,
        five_hour_pct=_coerce_percent(payload.get("fiveHour")),
        seven_day_pct=_coerce_percent(payload.get("sevenDay")),
        context_pct=None,
        five_hour_reset_at=_parse_usage_cache_date(payload.get("fiveHourResetAt")),
        seven_day_reset_at=_parse_usage_cache_date(payload.get("sevenDayResetAt")),
        cache_timestamp_ms=int(raw["timestamp"]) if isinstance(raw.get("timestamp"), (int, float)) else None,
    )


def load_usage_cache(path: Path) -> UsageSnapshot:
    if not path.exists():
        return UsageSnapshot()
    return parse_usage_cache(path)


def _usage_retry_until(raw: dict) -> int | None:
    data = raw.get("data")
    if not isinstance(data, dict) or data.get("apiError") != "rate-limited":
        return None
    retry_until = raw.get("retryAfterUntil")
    if isinstance(retry_until, (int, float)) and retry_until > raw.get("timestamp", 0):
        return int(retry_until)
    count = raw.get("rateLimitedCount")
    if not isinstance(count, (int, float)) or count <= 0:
        return None
    return int(raw.get("timestamp", 0)) + min(
        USAGE_RATE_LIMITED_BASE_MS * (2 ** max(0, int(count) - 1)),
        USAGE_RATE_LIMITED_MAX_MS,
    )


def read_usage_cache_state(cache_path: Path, now_ms: int) -> tuple[UsageSnapshot, bool] | None:
    raw = _load_json(cache_path, None)
    if not isinstance(raw, dict):
        return None
    snapshot = parse_usage_cache(cache_path)
    retry_until = _usage_retry_until(raw)
    if retry_until is not None and now_ms < retry_until:
        return (snapshot, True)
    data = raw.get("data")
    data_dict = data if isinstance(data, dict) else {}
    ttl_ms = USAGE_FAILURE_TTL_MS if data_dict.get("apiUnavailable") else USAGE_CACHE_TTL_MS
    timestamp_ms = snapshot.cache_timestamp_ms
    if timestamp_ms is None:
        return (snapshot, False)
    return (snapshot, now_ms - timestamp_ms < ttl_ms)


def read_last_good_usage(cache_path: Path) -> dict | None:
    raw = _load_json(cache_path, None)
    if not isinstance(raw, dict):
        return None
    last_good = raw.get("lastGoodData")
    return last_good if isinstance(last_good, dict) else None


def read_cached_plan_name(cache_path: Path) -> str | None:
    raw = _load_json(cache_path, None)
    if not isinstance(raw, dict):
        return None
    data = raw.get("data")
    if isinstance(data, dict) and data.get("planName"):
        return str(data["planName"])
    last_good = raw.get("lastGoodData")
    if isinstance(last_good, dict) and last_good.get("planName"):
        return str(last_good["planName"])
    return None


def write_usage_cache(
    cache_path: Path,
    data: dict,
    timestamp_ms: int,
    *,
    rate_limited_count: int | None = None,
    retry_after_until_ms: int | None = None,
    last_good_data: dict | None = None,
) -> None:
    _ensure_dir(cache_path.parent)
    payload: dict[str, object] = {"data": data, "timestamp": timestamp_ms}
    if rate_limited_count and rate_limited_count > 0:
        payload["rateLimitedCount"] = rate_limited_count
    if retry_after_until_ms:
        payload["retryAfterUntil"] = retry_after_until_ms
    if last_good_data:
        payload["lastGoodData"] = last_good_data
    cache_path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    os.chmod(cache_path, 0o600)


def _read_usage_lock_timestamp(path: Path) -> int | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def try_acquire_usage_lock(lock_path: Path) -> str:
    _ensure_dir(lock_path.parent)
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, str(int(time.time() * 1000)).encode("utf-8"))
        finally:
            os.close(fd)
        return "acquired"
    except FileExistsError:
        pass
    except OSError:
        return "unsupported"

    lock_timestamp = _read_usage_lock_timestamp(lock_path)
    if lock_timestamp is None:
        try:
            if int(time.time() * 1000) - int(lock_path.stat().st_mtime * 1000) < USAGE_CACHE_LOCK_STALE_MS:
                return "busy"
        except OSError:
            return try_acquire_usage_lock(lock_path)
    elif int(time.time() * 1000) - lock_timestamp < USAGE_CACHE_LOCK_STALE_MS:
        return "busy"

    try:
        lock_path.unlink()
    except OSError:
        return "busy"
    return try_acquire_usage_lock(lock_path)


def release_usage_lock(lock_path: Path) -> None:
    try:
        lock_path.unlink()
    except OSError:
        pass


def wait_for_usage_cache(cache_path: Path, lock_path: Path, timeout_ms: int = USAGE_CACHE_LOCK_WAIT_MS) -> UsageSnapshot | None:
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        time.sleep(USAGE_CACHE_LOCK_POLL_MS)
        cached = read_usage_cache_state(cache_path, int(time.time() * 1000))
        if cached and cached[1]:
            return cached[0]
        if not lock_path.exists():
            break
    cached = read_usage_cache_state(cache_path, int(time.time() * 1000))
    return cached[0] if cached else None


def usage_plan_name(subscription_type: str) -> str | None:
    lower = subscription_type.lower()
    if "max" in lower:
        return "Max"
    if "pro" in lower:
        return "Pro"
    if "team" in lower:
        return "Team"
    if not subscription_type or "api" in lower:
        return None
    return subscription_type[:1].upper() + subscription_type[1:]


def parse_retry_after_seconds(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = int(value)
    except ValueError:
        parsed = None
    if parsed and parsed > 0:
        return parsed
    return None


def using_custom_api_endpoint(env: dict[str, str] | None = None) -> bool:
    source = env or os.environ
    base_url = (source.get("ANTHROPIC_BASE_URL") or source.get("ANTHROPIC_API_BASE_URL") or "").strip()
    if not base_url:
        return False
    try:
        parsed = urlparse(base_url)
        return f"{parsed.scheme}://{parsed.netloc}" != "https://api.anthropic.com"
    except Exception:
        return True


def fetch_usage_api(access_token: str) -> tuple[dict | None, str | None, int | None]:
    request = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/usage",
        headers={
            "Authorization": f"Bearer {access_token}",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/2.1",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=USAGE_API_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else None, None, None
    except urllib.error.HTTPError as exc:
        error = "rate-limited" if exc.code == 429 else f"http-{exc.code}"
        return None, error, parse_retry_after_seconds(exc.headers.get("Retry-After"))
    except urllib.error.URLError:
        return None, "network", None
    except (TimeoutError, json.JSONDecodeError, OSError):
        return None, "timeout", None


def refresh_usage_cache(
    cache_path: Path,
    lock_path: Path,
    access_token: str,
    subscription_type: str,
    *,
    force: bool = False,
    env: dict[str, str] | None = None,
) -> bool:
    if not access_token or using_custom_api_endpoint(env):
        return False

    now_ms = int(time.time() * 1000)
    cache_state = None if force else read_usage_cache_state(cache_path, now_ms)
    if cache_state and cache_state[1]:
        return True
    if force:
        cache_state = read_usage_cache_state(cache_path, now_ms)

    holds_lock = False
    lock_status = try_acquire_usage_lock(lock_path)
    if lock_status == "busy":
        if cache_state:
            return True
        return wait_for_usage_cache(cache_path, lock_path) is not None
    holds_lock = lock_status == "acquired"

    try:
        if not force:
            refreshed_cache = read_usage_cache_state(cache_path, int(time.time() * 1000))
            if refreshed_cache and refreshed_cache[1]:
                return True

        plan_name = usage_plan_name(subscription_type)
        if not plan_name and not subscription_type.strip():
            plan_name = read_cached_plan_name(cache_path)
        if not plan_name:
            return False

        api_data, api_error, retry_after_seconds = fetch_usage_api(access_token)
        now_ms = int(time.time() * 1000)
        if api_data is None:
            is_rate_limited = api_error == "rate-limited"
            prev_raw = _load_json(cache_path, {})
            prev_count = int(prev_raw.get("rateLimitedCount", 0)) if isinstance(prev_raw, dict) else 0
            rate_limited_count = prev_count + 1 if is_rate_limited else 0
            retry_after_until_ms = now_ms + retry_after_seconds * 1000 if is_rate_limited and retry_after_seconds else None
            failure_result = {
                "planName": plan_name,
                "fiveHour": None,
                "sevenDay": None,
                "fiveHourResetAt": None,
                "sevenDayResetAt": None,
                "apiUnavailable": True,
                "apiError": api_error or "unknown",
            }
            last_good = read_last_good_usage(cache_path)
            write_usage_cache(
                cache_path,
                failure_result,
                now_ms,
                rate_limited_count=rate_limited_count if is_rate_limited else None,
                retry_after_until_ms=retry_after_until_ms,
                last_good_data=last_good,
            )
            return last_good is not None or not is_rate_limited

        five_hour = _coerce_percent(((api_data.get("five_hour") or {}) if isinstance(api_data, dict) else {}).get("utilization"))
        seven_day = _coerce_percent(((api_data.get("seven_day") or {}) if isinstance(api_data, dict) else {}).get("utilization"))
        five_hour_reset_at = _parse_usage_cache_date(((api_data.get("five_hour") or {}) if isinstance(api_data, dict) else {}).get("resets_at"))
        seven_day_reset_at = _parse_usage_cache_date(((api_data.get("seven_day") or {}) if isinstance(api_data, dict) else {}).get("resets_at"))
        result = {
            "planName": plan_name,
            "fiveHour": five_hour,
            "sevenDay": seven_day,
            "fiveHourResetAt": five_hour_reset_at,
            "sevenDayResetAt": seven_day_reset_at,
        }
        write_usage_cache(cache_path, result, now_ms, last_good_data=result)
        return True
    finally:
        if holds_lock:
            release_usage_lock(lock_path)
