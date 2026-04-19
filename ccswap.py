#!/usr/bin/env python3
"""Interactive Claude Code account switcher with auto-swap support.

Key ideas:
- each account owns its own CLAUDE_CONFIG_DIR
- `ccswap` can login/logout/check status per account
- launching Claude goes through a wrapper that can rotate to the next account
  when Claude reports a usage/rate limit
- running without subcommands opens a small curses dashboard
"""

from __future__ import annotations

import argparse
import curses
import datetime as dt
import json
import os
import pty
import re
import select
import shlex
import signal
import struct
import subprocess
import sys
import termios
import time
import textwrap
import tty
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from ccswap_runtime import (
    RuntimeSessionView,
    SessionRuntimeState,
    cleanup_stale_runtime_sessions as _cleanup_stale_runtime_sessions,
    list_runtime_sessions as _list_runtime_sessions,
    runtime_dir_stamp as _runtime_dir_stamp,
    runtime_settings_path as _runtime_settings_path,
    runtime_state_path as _runtime_state_path,
    update_runtime_state as _update_runtime_state,
)
from ccswap_usage import (
    UsageSnapshot,
    load_usage_cache as _load_usage_cache,
    parse_usage_cache as _parse_usage_cache,
    read_usage_cache_state as _usage_read_cache_state,
    read_cached_plan_name as _usage_read_cached_plan_name,
    read_last_good_usage as _usage_read_last_good_usage,
    refresh_usage_cache as _refresh_usage_cache,
)


APP_NAME = "ccswap"
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / APP_NAME
CONFIG_PATH = CONFIG_DIR / "config.json"
STATE_PATH = CONFIG_DIR / "state.json"
ACCOUNTS_DIR = CONFIG_DIR / "accounts"
LOG_PATH = CONFIG_DIR / "ccswap.log"
RUNTIME_DIR = CONFIG_DIR / "runtime"
USAGE_CACHE_DIR = CONFIG_DIR / "usage-cache"
DEFAULT_CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "claude")
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"
CCSWAP_KEYCHAIN_PREFIX = "ccswap-account"
REPLAY_MODES = ("last_prompt", "continue", "custom_prompt")
OPTIONS_WITH_VALUE = {
    "--add-dir",
    "--agent",
    "--agents",
    "--allowedTools",
    "--allowed-tools",
    "--append-system-prompt",
    "--betas",
    "--debug",
    "--debug-file",
    "--disallowedTools",
    "--disallowed-tools",
    "--effort",
    "--fallback-model",
    "--file",
    "--from-pr",
    "--input-format",
    "--json-schema",
    "--max-budget-usd",
    "--mcp-config",
    "--model",
    "--name",
    "--output-format",
    "--permission-mode",
    "--plugin-dir",
    "--remote-control-session-name-prefix",
    "--resume",
    "-r",
    "--session-id",
    "--setting-sources",
    "--settings",
    "--system-prompt",
    "--tools",
    "--worktree",
    "-w",
    "-n",
}

LIMIT_PATTERNS = [
    re.compile(r"you['’]ve hit your limit", re.IGNORECASE),
    re.compile(r"you['’]ve reached your limit", re.IGNORECASE),
    re.compile(r"you['’]ve reached your usage limit", re.IGNORECASE),
    re.compile(r"usage limit reached", re.IGNORECASE),
    re.compile(r"max usage limit", re.IGNORECASE),
    re.compile(r"api error:\s*rate limit reached", re.IGNORECASE),
    re.compile(r"\brate limit reached\b", re.IGNORECASE),
    re.compile(r"\brate limited\b", re.IGNORECASE),
    re.compile(r"\bquota exhausted\b", re.IGNORECASE),
    re.compile(r"\b429 too many requests\b", re.IGNORECASE),
]
ANSI_ESCAPE_PATTERN = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]")
RESUME_HINT_PATTERN = re.compile(r"claude\s+--resume\s+([0-9a-f-]{8,})", re.IGNORECASE)


@dataclass
class Account:
    name: str
    claude_config_dir: str
    auto_swap: bool = True
    keychain_service: str = ""
    keychain_account: str = ""

    @classmethod
    def from_dict(cls, data: dict) -> "Account":
        name = str(data["name"])
        config_dir = str(data.get("claude_config_dir") or default_account_dir(name))
        return cls(
            name=name,
            claude_config_dir=config_dir,
            auto_swap=bool(data.get("auto_swap", data.get("enabled", True))),
            keychain_service=str(data.get("keychain_service", "")),
            keychain_account=str(data.get("keychain_account", "")),
        )

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "claude_config_dir": self.claude_config_dir,
            "auto_swap": self.auto_swap,
            "keychain_service": self.keychain_service,
            "keychain_account": self.keychain_account,
        }


@dataclass
class AppConfig:
    accounts: list[Account]
    claude_bin: str = DEFAULT_CLAUDE_BIN
    replay_mode: str = "last_prompt"
    custom_prompt: str = ""

    @classmethod
    def load(cls) -> "AppConfig":
        data = _load_json(
            CONFIG_PATH,
            {
                "accounts": [],
                "claude_bin": DEFAULT_CLAUDE_BIN,
                "replay_mode": "last_prompt",
                "custom_prompt": "",
            },
        )
        accounts = [Account.from_dict(item) for item in data.get("accounts", [])]
        config = cls(
            accounts=accounts,
            claude_bin=str(data.get("claude_bin", DEFAULT_CLAUDE_BIN)),
            replay_mode=str(data.get("replay_mode", "last_prompt")),
            custom_prompt=str(data.get("custom_prompt", "")),
        )
        config.normalize_accounts()
        return config

    def save(self) -> None:
        self.normalize_accounts()
        _ensure_dir(CONFIG_DIR)
        CONFIG_PATH.write_text(
            json.dumps(
                {
                    "accounts": [account.to_dict() for account in self.accounts],
                    "claude_bin": self.claude_bin,
                    "replay_mode": self.replay_mode,
                    "custom_prompt": self.custom_prompt,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        os.chmod(CONFIG_PATH, 0o600)

    def get_account(self, name: str) -> Account | None:
        for account in self.accounts:
            if account.name == name:
                return account
        return None

    def normalize_accounts(self) -> None:
        seen_dirs: set[str] = set()
        for account in self.accounts:
            if not account.claude_config_dir:
                account.claude_config_dir = str(default_account_dir(account.name))
            normalized_dir = str(Path(account.claude_config_dir).expanduser())
            if normalized_dir in seen_dirs:
                normalized_dir = str(default_account_dir(account.name))
            account.claude_config_dir = normalized_dir
            if not account.keychain_service:
                account.keychain_service = default_keychain_service(account.name)
            if not account.keychain_account:
                account.keychain_account = default_keychain_account()
            seen_dirs.add(normalized_dir)
        if self.replay_mode not in REPLAY_MODES:
            self.replay_mode = "last_prompt"


@dataclass
class AppState:
    active_account: str | None = None
    last_account: str | None = None

    @classmethod
    def load(cls) -> "AppState":
        data = _load_json(
            STATE_PATH,
            {"active_account": None, "last_account": None},
        )
        return cls(
            active_account=str(data["active_account"]) if data.get("active_account") else None,
            last_account=str(data["last_account"]) if data.get("last_account") else None,
        )

    def save(self) -> None:
        _ensure_dir(CONFIG_DIR)
        STATE_PATH.write_text(
            json.dumps(
                {
                    "active_account": self.active_account,
                    "last_account": self.last_account,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        os.chmod(STATE_PATH, 0o600)


@dataclass
class AuthStatus:
    logged_in: bool
    email: str | None = None
    auth_method: str | None = None
    subscription_type: str | None = None
    org_name: str | None = None
    error: str | None = None
    stored_login: bool = False


@dataclass
class AccountView:
    account: Account
    auth: AuthStatus
    usage: "UsageSnapshot"


@dataclass
class ClaudeRunResult:
    exit_code: int
    limit_hit: bool


@dataclass
class InteractiveCommandResult:
    exit_code: int
    output: str


@dataclass
class StoredCredential:
    service: str
    account: str
    secret: str


def log_event(message: str) -> None:
    try:
        _ensure_dir(CONFIG_DIR)
        timestamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(f"{timestamp} {message}\n")
    except OSError:
        pass


def account_usage_cache_dir(account: Account) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", account.name).strip("-") or "account"
    return USAGE_CACHE_DIR / safe


def account_usage_cache_path(account: Account) -> Path:
    return account_usage_cache_dir(account) / "usage.json"


def account_usage_lock_path(account: Account) -> Path:
    return account_usage_cache_dir(account) / "usage.lock"


def parse_usage_cache(path: Path) -> UsageSnapshot:
    return _parse_usage_cache(path)


def load_account_usage(account: Account) -> UsageSnapshot:
    return _load_usage_cache(account_usage_cache_path(account))


def _read_usage_cache_state(account: Account, now_ms: int) -> tuple[UsageSnapshot, bool] | None:
    return _usage_read_cache_state(account_usage_cache_path(account), now_ms)


def _read_last_good_usage(account: Account) -> dict | None:
    return _usage_read_last_good_usage(account_usage_cache_path(account))


def _read_cached_plan_name(account: Account) -> str | None:
    return _usage_read_cached_plan_name(account_usage_cache_path(account))


def runtime_state_path(run_id: str) -> Path:
    return _runtime_state_path(RUNTIME_DIR, run_id)


def runtime_settings_path(run_id: str) -> Path:
    return _runtime_settings_path(RUNTIME_DIR, run_id)


def process_is_alive(pid: int | None) -> bool:
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def cleanup_stale_runtime_sessions() -> None:
    _cleanup_stale_runtime_sessions(RUNTIME_DIR, process_is_alive)


def remove_account_usage_cache(account: Account) -> None:
    for path in (account_usage_cache_path(account), account_usage_lock_path(account)):
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass


def replay_mode_label(mode: str) -> str:
    labels = {
        "last_prompt": "Last prompt",
        "continue": "Continue only",
        "custom_prompt": "Custom prompt",
    }
    return labels.get(mode, mode)


def runtime_dir_stamp() -> tuple[int, int]:
    return _runtime_dir_stamp(RUNTIME_DIR, process_is_alive)


def list_runtime_sessions() -> list[RuntimeSessionView]:
    return _list_runtime_sessions(RUNTIME_DIR, process_is_alive)


def default_keychain_account() -> str:
    return os.environ.get("USER", "ccswap")


def default_keychain_service(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "account"
    return f"{CCSWAP_KEYCHAIN_PREFIX}:{safe}"


def _security_find_password(service: str) -> str | None:
    result = subprocess.run(
        ["security", "find-generic-password", "-s", service, "-w"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.rstrip("\n")


def _security_store_password(service: str, account: str, secret: str) -> bool:
    result = subprocess.run(
        [
            "security",
            "add-generic-password",
            "-U",
            "-a",
            account,
            "-s",
            service,
            "-w",
            secret,
            "login.keychain-db",
        ],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def _security_delete_password(service: str) -> None:
    subprocess.run(
        ["security", "delete-generic-password", "-s", service, "login.keychain-db"],
        capture_output=True,
        text=True,
    )


def get_standard_claude_credentials() -> StoredCredential | None:
    secret = _security_find_password(CLAUDE_KEYCHAIN_SERVICE)
    if not secret:
        return None
    return StoredCredential(
        service=CLAUDE_KEYCHAIN_SERVICE,
        account=default_keychain_account(),
        secret=secret,
    )


def get_account_credentials(account: Account) -> StoredCredential | None:
    secret = _security_find_password(account.keychain_service)
    if not secret:
        return None
    return StoredCredential(
        service=account.keychain_service,
        account=account.keychain_account or default_keychain_account(),
        secret=secret,
    )


def store_account_credentials(account: Account, credential: StoredCredential) -> bool:
    if not credential.secret:
        return False
    account.keychain_account = credential.account or default_keychain_account()
    return _security_store_password(account.keychain_service, account.keychain_account, credential.secret)


def activate_account_credentials(account: Account) -> bool:
    credential = get_account_credentials(account)
    if credential is None:
        return False
    return _security_store_password(
        CLAUDE_KEYCHAIN_SERVICE,
        credential.account or default_keychain_account(),
        credential.secret,
    )


def delete_account_credentials(account: Account) -> None:
    if account.keychain_service:
        _security_delete_password(account.keychain_service)


def parse_stored_credential(secret: str | None) -> dict[str, str | None]:
    if not secret:
        return {"subscription_type": None}
    try:
        payload = json.loads(secret)
    except json.JSONDecodeError:
        return {"subscription_type": None}
    oauth = payload.get("claudeAiOauth") if isinstance(payload, dict) else None
    if not isinstance(oauth, dict):
        return {"subscription_type": None, "access_token": None}
    return {
        "subscription_type": str(oauth.get("subscriptionType")) if oauth.get("subscriptionType") else None,
        "access_token": str(oauth.get("accessToken")) if oauth.get("accessToken") else None,
    }


def _append_hook(target: dict, event: str, matcher: str | None, hook: dict) -> None:
    hooks = target.setdefault("hooks", {})
    entries = hooks.setdefault(event, [])
    entry: dict[str, object] = {"hooks": [hook]}
    if matcher is not None:
        entry["matcher"] = matcher
    entries.append(entry)


def merge_settings(base: dict, extra: dict) -> dict:
    merged = json.loads(json.dumps(base))
    for key, value in extra.items():
        if key == "hooks":
            merged_hooks = merged.setdefault("hooks", {})
            for event, entries in value.items():
                merged_hooks.setdefault(event, [])
                merged_hooks[event].extend(entries)
            continue
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = merge_settings(merged[key], value)
            continue
        merged[key] = value
    return merged


def load_settings_value(raw: str) -> dict | None:
    candidate = Path(raw).expanduser()
    if candidate.exists():
        return _load_json(candidate, {})
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def build_runtime_hook_settings(run_id: str, state_path: Path) -> dict:
    script_path = str(Path(__file__).resolve())
    session_hook = {
        "type": "command",
        "command": f"python3 {shlex.quote(script_path)} hook session-start --run-id {shlex.quote(run_id)} --state-path {shlex.quote(str(state_path))}",
    }
    prompt_hook = {
        "type": "command",
        "command": f"python3 {shlex.quote(script_path)} hook prompt-submit --run-id {shlex.quote(run_id)} --state-path {shlex.quote(str(state_path))}",
    }
    settings: dict[str, object] = {"hooks": {}}
    _append_hook(settings, "SessionStart", None, session_hook)
    _append_hook(settings, "UserPromptSubmit", None, prompt_hook)
    return settings


def inject_runtime_settings(original_args: list[str], run_id: str, state_path: Path) -> tuple[list[str], Path]:
    merged_settings: dict = {}
    args = list(original_args)
    existing_settings: list[str] = []
    idx = 0
    while idx < len(args):
        if args[idx] == "--settings" and idx + 1 < len(args):
            existing_settings.append(args[idx + 1])
            del args[idx : idx + 2]
            continue
        idx += 1

    for raw in existing_settings:
        loaded = load_settings_value(raw)
        if loaded is None:
            log_event(f"warning unable to parse --settings value for runtime merge: {raw!r}")
            continue
        merged_settings = merge_settings(merged_settings, loaded)

    merged_settings = merge_settings(merged_settings, build_runtime_hook_settings(run_id, state_path))
    settings_path = runtime_settings_path(run_id)
    _ensure_dir(settings_path.parent)
    settings_path.write_text(json.dumps(merged_settings, indent=2) + "\n", encoding="utf-8")
    os.chmod(settings_path, 0o600)
    return [*args, "--settings", str(settings_path)], settings_path


class LimitDetector:
    def __init__(self) -> None:
        self._buffer = ""
        self.matched_text: str | None = None

    @property
    def matched(self) -> bool:
        return self.matched_text is not None

    def feed(self, data: bytes) -> None:
        if self.matched:
            return
        text = data.decode("utf-8", errors="ignore")
        if not text:
            return
        self._buffer = (self._buffer + text)[-12000:]
        for pattern in LIMIT_PATTERNS:
            if pattern.search(self._buffer):
                self.matched_text = self._buffer
                return

    def reset(self) -> None:
        self._buffer = ""
        self.matched_text = None

class ClaudeRunner:
    def __init__(
        self,
        claude_bin: str,
        account: Account,
        args: list[str],
        launch_cwd: str,
        claude_config_dir: str | None,
    ) -> None:
        self.claude_bin = claude_bin
        self.account = account
        self.args = args
        self.launch_cwd = launch_cwd
        self.claude_config_dir = claude_config_dir

    def run(
        self,
        on_started: Callable[[int], None] | None = None,
        on_session_hint: Callable[[str], None] | None = None,
        should_arm_limit: Callable[[], bool] | None = None,
        should_confirm_limit: Callable[[], bool] | None = None,
    ) -> ClaudeRunResult:
        master_fd, slave_fd = pty.openpty()
        stdin_fd = sys.stdin.fileno()
        stdout_fd = sys.stdout.fileno()
        detector = LimitDetector()
        hint_buffer = ""

        env = _claude_env(self.claude_config_dir)
        process = subprocess.Popen(
            [self.claude_bin, *self.args],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,
            env=env,
            cwd=self.launch_cwd,
            close_fds=True,
        )
        os.close(slave_fd)
        if on_started is not None:
            on_started(process.pid)

        old_tty = None
        old_handler = None
        limit_exit_requested = False
        limit_term_requested = False
        limit_kill_requested = False
        limit_confirmed = False
        limit_detected_at: float | None = None
        limit_exit_deadline: float | None = None
        limit_kill_deadline: float | None = None

        def sync_winsize(*_args: object) -> None:
            if not os.isatty(stdin_fd):
                return
            rows, cols = _get_winsize(stdin_fd)
            payload = struct.pack("HHHH", rows, cols, 0, 0)
            _ioctl_set_winsize(master_fd, payload)
            try:
                os.killpg(process.pid, signal.SIGWINCH)
            except ProcessLookupError:
                pass

        try:
            if os.isatty(stdin_fd):
                old_tty = termios.tcgetattr(stdin_fd)
                tty.setraw(stdin_fd)
                sync_winsize()
                old_handler = signal.getsignal(signal.SIGWINCH)
                signal.signal(signal.SIGWINCH, sync_winsize)

            while True:
                read_fds = [master_fd]
                if process.poll() is None:
                    read_fds.append(stdin_fd)
                ready, _, _ = select.select(read_fds, [], [], 0.1)

                if master_fd in ready:
                    try:
                        output = os.read(master_fd, 8192)
                    except OSError:
                        output = b""
                    if output:
                        os.write(stdout_fd, output)
                        chunk_text = output.decode("utf-8", errors="ignore")
                        if should_arm_limit is None or should_arm_limit():
                            detector.feed(output)
                        if chunk_text:
                            hint_buffer = (hint_buffer + chunk_text)[-8000:]
                            matches = RESUME_HINT_PATTERN.findall(hint_buffer)
                            if matches and on_session_hint is not None:
                                on_session_hint(matches[-1])
                    else:
                        break

                if stdin_fd in ready and process.poll() is None:
                    try:
                        incoming = os.read(stdin_fd, 1024)
                    except OSError:
                        incoming = b""
                    if incoming:
                        try:
                            os.write(master_fd, incoming)
                        except OSError:
                            pass

                if detector.matched and limit_detected_at is None:
                    limit_detected_at = time.monotonic()
                    log_event(f"limit text detected on account={self.account.name}")

                if (
                    detector.matched
                    and limit_detected_at is not None
                    and not limit_exit_requested
                    and process.poll() is None
                    and time.monotonic() - limit_detected_at >= 1.0
                ):
                    if should_confirm_limit is not None and not should_confirm_limit():
                        log_event(f"limit text ignored by usage check on account={self.account.name}")
                        detector.reset()
                        limit_detected_at = None
                        continue
                    limit_confirmed = True
                    limit_exit_requested = True
                    limit_exit_deadline = time.monotonic() + 1.0
                    limit_kill_deadline = time.monotonic() + 2.5
                    log_event(f"limit confirmed on account={self.account.name}")
                    self._announce_limit_switch()
                    self._try_graceful_exit(master_fd)

                if (
                    detector.matched
                    and limit_exit_deadline is not None
                    and not limit_term_requested
                    and process.poll() is None
                    and time.monotonic() >= limit_exit_deadline
                ):
                    limit_term_requested = True
                    log_event(f"sending SIGTERM to account={self.account.name} pid={process.pid}")
                    self._terminate_process_group(process.pid, signal.SIGTERM)

                if (
                    detector.matched
                    and limit_kill_deadline is not None
                    and not limit_kill_requested
                    and process.poll() is None
                    and time.monotonic() >= limit_kill_deadline
                ):
                    limit_kill_requested = True
                    log_event(f"sending SIGKILL to account={self.account.name} pid={process.pid}")
                    self._terminate_process_group(process.pid, signal.SIGKILL)

                if process.poll() is not None and master_fd not in ready:
                    break
        finally:
            if old_tty is not None:
                termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_tty)
            if old_handler is not None:
                signal.signal(signal.SIGWINCH, old_handler)
            try:
                os.close(master_fd)
            except OSError:
                pass

        exit_code = process.wait()
        log_event(
            f"runner exit account={self.account.name} exit_code={exit_code} limit_hit={limit_confirmed}"
        )
        return ClaudeRunResult(exit_code=exit_code, limit_hit=limit_confirmed)

    @staticmethod
    def _announce_limit_switch() -> None:
        os.write(
            sys.stderr.fileno(),
            b"\r\n[ccswap] Claude limit detected. Rotating to the next account...\r\n",
        )

    @staticmethod
    def _try_graceful_exit(master_fd: int) -> None:
        for payload in (b"\x03", b"\x1b", b"1\n", b"/exit\n", b"exit\n"):
            try:
                os.write(master_fd, payload)
            except OSError:
                break

    @staticmethod
    def _terminate_process_group(pid: int, sig: int) -> None:
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            pass


def run_interactive_command_capture(
    cmd: list[str],
    env: dict[str, str],
    cwd: str,
    title: str | None = None,
) -> InteractiveCommandResult:
    master_fd, slave_fd = pty.openpty()
    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()
    capture: list[str] = []

    process = subprocess.Popen(
        cmd,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        start_new_session=True,
        env=env,
        cwd=cwd,
        close_fds=True,
    )
    os.close(slave_fd)

    old_tty = None
    old_handler = None

    def sync_winsize(*_args: object) -> None:
        if not os.isatty(stdin_fd):
            return
        rows, cols = _get_winsize(stdin_fd)
        payload = struct.pack("HHHH", rows, cols, 0, 0)
        _ioctl_set_winsize(master_fd, payload)
        try:
            os.killpg(process.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    try:
        if title:
            os.write(stdout_fd, f"[ccswap] {title}\r\n".encode("utf-8"))
        if os.isatty(stdin_fd):
            old_tty = termios.tcgetattr(stdin_fd)
            tty.setraw(stdin_fd)
            sync_winsize()
            old_handler = signal.getsignal(signal.SIGWINCH)
            signal.signal(signal.SIGWINCH, sync_winsize)

        while True:
            read_fds = [master_fd]
            if process.poll() is None:
                read_fds.append(stdin_fd)
            ready, _, _ = select.select(read_fds, [], [], 0.1)

            if master_fd in ready:
                try:
                    output = os.read(master_fd, 8192)
                except OSError:
                    output = b""
                if output:
                    os.write(stdout_fd, output)
                    capture.append(output.decode("utf-8", errors="ignore"))
                else:
                    break

            if stdin_fd in ready and process.poll() is None:
                try:
                    incoming = os.read(stdin_fd, 1024)
                except OSError:
                    incoming = b""
                if incoming:
                    try:
                        os.write(master_fd, incoming)
                    except OSError:
                        pass

            if process.poll() is not None and master_fd not in ready:
                break
    finally:
        if old_tty is not None:
            termios.tcsetattr(stdin_fd, termios.TCSADRAIN, old_tty)
        if old_handler is not None:
            signal.signal(signal.SIGWINCH, old_handler)
        try:
            os.close(master_fd)
        except OSError:
            pass

    exit_code = process.wait()
    return InteractiveCommandResult(exit_code=exit_code, output="".join(capture))


def update_runtime_state(
    state_path: Path,
    run_id: str,
    *,
    session_id: str | None = None,
    last_prompt: str | None = None,
    last_prompt_at: str | None = None,
    detector_armed: bool | None = None,
    cwd: str | None = None,
    active_account: str | None = None,
    replay_mode: str | None = None,
    custom_prompt: str | None = None,
    started_at: str | None = None,
    claude_pid: int | None = None,
) -> SessionRuntimeState:
    return _update_runtime_state(
        state_path,
        run_id,
        session_id=session_id,
        last_prompt=last_prompt,
        last_prompt_at=last_prompt_at,
        detector_armed=detector_armed,
        cwd=cwd,
        active_account=active_account,
        replay_mode=replay_mode,
        custom_prompt=custom_prompt,
        started_at=started_at,
        claude_pid=claude_pid,
    )


class Dashboard:
    def __init__(self, stdscr: "curses._CursesWindow", config: AppConfig, state: AppState) -> None:
        self.stdscr = stdscr
        self.config = config
        self.state = state
        self.account_selected_index = 0
        self.session_selected_index = 0
        self.screen_mode = "accounts"
        self.message = "Ready"
        self.views: list[AccountView] = []
        self.runtime_sessions: list[RuntimeSessionView] = []
        self.colors: dict[str, int] = {}
        self._config_mtime_ns = file_mtime_ns(CONFIG_PATH)
        self._state_mtime_ns = file_mtime_ns(STATE_PATH)
        self._runtime_stamp = runtime_dir_stamp()
        self._usage_refresh_cursor = 0
        self.refresh_views()

    def run(self) -> int:
        _safe_curs_set(0)
        self.stdscr.timeout(500)
        self.stdscr.keypad(True)
        self.setup_theme()

        while True:
            self.reload_if_changed()
            self.maybe_refresh_usage()
            self.draw()
            key = self.stdscr.getch()

            if key == -1:
                continue
            if key in (ord("q"), 27):
                return 0
            if key == ord("\t"):
                self.toggle_screen_mode()
                continue
            if key in (curses.KEY_UP, ord("k")):
                self.move_selection(-1)
            elif key in (curses.KEY_DOWN, ord("j")):
                self.move_selection(1)
            elif key == ord("a") and self.screen_mode == "accounts":
                self.add_account_prompt()
            elif key == ord("l") and self.screen_mode == "accounts":
                self.login_selected()
            elif key == ord("r") and self.screen_mode == "accounts":
                self.rename_selected()
            elif key == ord("s") and self.screen_mode == "sessions":
                self.open_settings_panel()
            elif key in (curses.KEY_ENTER, 10, 13) and self.screen_mode == "accounts":
                self.set_selected_active()
            elif key == ord(" ") and self.screen_mode == "accounts":
                self.toggle_selected_enabled()
            elif key == ord("d") and self.screen_mode == "accounts":
                self.delete_selected()
            elif key == ord("?"):
                self.show_help()
            elif key in (ord("1"), ord("2"), ord("3"), ord("4"), ord("5"), ord("6"), ord("7"), ord("8"), ord("9")):
                self.select_numeric_account(key - ord("1"))

    def reload_if_changed(self) -> None:
        config_mtime_ns = file_mtime_ns(CONFIG_PATH)
        state_mtime_ns = file_mtime_ns(STATE_PATH)
        runtime_stamp = runtime_dir_stamp()
        if (
            config_mtime_ns == self._config_mtime_ns
            and state_mtime_ns == self._state_mtime_ns
            and runtime_stamp == self._runtime_stamp
        ):
            return

        selected_name = self.current_view().account.name if self.current_view() else None
        selected_run_id = self.current_session_view().state.run_id if self.current_session_view() else None
        self.config = AppConfig.load()
        self.state = AppState.load()
        self._config_mtime_ns = config_mtime_ns
        self._state_mtime_ns = state_mtime_ns
        self._runtime_stamp = runtime_stamp
        self.refresh_views()

        if selected_name:
            for idx, view in enumerate(self.views):
                if view.account.name == selected_name:
                    self.account_selected_index = idx
                    break
        if selected_run_id:
            for idx, item in enumerate(self.runtime_sessions):
                if item.state.run_id == selected_run_id:
                    self.session_selected_index = idx
                    break

    def setup_theme(self) -> None:
        self.colors = {
            "normal": curses.A_NORMAL,
            "muted": curses.A_DIM,
            "title": curses.A_BOLD,
            "header": curses.A_BOLD | curses.A_UNDERLINE,
            "selected": curses.A_BOLD,
            "accent": curses.A_BOLD,
            "ok": curses.A_BOLD,
            "warn": curses.A_BOLD,
            "danger": curses.A_BOLD,
            "selection_bar": curses.A_BOLD,
            "selected_row": curses.A_BOLD,
        }
        if not curses.has_colors():
            return
        try:
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_CYAN, -1)
            curses.init_pair(2, curses.COLOR_BLUE, -1)
            curses.init_pair(3, curses.COLOR_CYAN, -1)
            curses.init_pair(4, curses.COLOR_MAGENTA, -1)
            curses.init_pair(5, curses.COLOR_RED, -1)
            self.colors.update(
                {
                    "title": curses.color_pair(1) | curses.A_BOLD,
                    "header": curses.color_pair(2) | curses.A_BOLD,
                    "selected": curses.A_BOLD,
                    "accent": curses.color_pair(4) | curses.A_BOLD,
                    "ok": curses.color_pair(3),
                    "warn": curses.color_pair(4),
                    "danger": curses.color_pair(5),
                    "selection_bar": curses.color_pair(4) | curses.A_BOLD,
                    "selected_row": curses.color_pair(1) | curses.A_BOLD,
                }
            )
        except curses.error:
            pass

    def refresh_views(self) -> None:
        if self.state.active_account and not any(
            account.name == self.state.active_account for account in self.config.accounts
        ):
            self.state.active_account = self.config.accounts[0].name if self.config.accounts else None
        if self.state.last_account and not any(
            account.name == self.state.last_account for account in self.config.accounts
        ):
            self.state.last_account = self.state.active_account
        self.state.save()
        self.views = []
        for account in self.config.accounts:
            auth = get_auth_status(account, self.config.claude_bin)
            usage = load_account_usage(account)
            self.views.append(AccountView(account=account, auth=auth, usage=usage))
        self.runtime_sessions = list_runtime_sessions()
        if self.account_selected_index >= len(self.views):
            self.account_selected_index = max(0, len(self.views) - 1)
        if self.session_selected_index >= len(self.runtime_sessions):
            self.session_selected_index = max(0, len(self.runtime_sessions) - 1)

    def maybe_refresh_usage(self) -> None:
        if not self.views:
            return
        total = len(self.views)
        for offset in range(total):
            idx = (self._usage_refresh_cursor + offset) % total
            view = self.views[idx]
            if not view.auth.stored_login:
                continue
            self._usage_refresh_cursor = (idx + 1) % total
            if refresh_account_usage(view.account):
                self.refresh_views()
            return

    def draw(self) -> None:
        self.stdscr.erase()
        height, width = self.stdscr.getmaxyx()
        title = "CCSWAP"
        selected_label = (
            f"{self.account_selected_index + 1}/{len(self.views)}"
            if self.screen_mode == "accounts" and self.views
            else f"{self.session_selected_index + 1}/{len(self.runtime_sessions)}"
            if self.screen_mode == "sessions" and self.runtime_sessions
            else "0/0"
        )
        subtitle = (
            f"replay {replay_mode_label(self.config.replay_mode)}  "
            f"active {self.state.active_account or '-'}  "
            f"screen {self.screen_mode}  "
            f"selected {selected_label}"
        )
        shortcuts = self.shortcuts_for_screen()

        self.stdscr.addnstr(0, 1, title, max(1, width - 2), self.colors["title"])
        self.stdscr.addnstr(2, 1, subtitle, max(1, width - 2), self.colors["muted"])
        if self.message and self.message != "Ready":
            info_attr = self.colors["ok"] if not self.message.lower().startswith(("error", "failed")) else self.colors["danger"]
            self.stdscr.addnstr(3, 1, fit_text(f"info  {self.message}", width - 2), max(1, width - 2), info_attr)
        else:
            self.stdscr.addnstr(3, 1, "info  Ready", max(1, width - 2), self.colors["muted"])
        if self.screen_mode == "accounts":
            self.draw_accounts_screen(height, width)
        else:
            self.draw_sessions_screen(height, width)

        footer_y = height - 2
        self.draw_rule(footer_y, width - 2)
        self.draw_shortcuts(height - 1, 1, width - 2, shortcuts, prefix="keys: ")
        self.stdscr.refresh()

    def shortcuts_for_screen(self) -> list[tuple[str, str]]:
        if self.screen_mode == "accounts":
            return [
                ("Tab", "Sessions"),
                ("a", "Add"),
                ("l", "Login"),
                ("r", "Rename"),
                ("Enter", "Set active"),
                ("Space", "Swap"),
                ("d", "Delete"),
                ("?", "Help"),
                ("q", "Quit"),
            ]
        return [
            ("Tab", "Accounts"),
            ("j/k", "Move"),
            ("s", "Settings"),
            ("?", "Help"),
            ("q", "Quit"),
        ]

    def toggle_screen_mode(self) -> None:
        self.screen_mode = "sessions" if self.screen_mode == "accounts" else "accounts"
        self.message = f"Switched to {self.screen_mode}."

    def draw_accounts_screen(self, height: int, width: int) -> None:
        section_y = 5
        visible_upper = len(self.views)
        account_detail = f"showing 1-{visible_upper} of {len(self.views)}" if self.views else "empty"
        self.draw_section_title(section_y, width - 2, "ACCOUNTS", account_detail)

        inner_width = max(50, width - 3)
        col_cursor = 2
        col_number = 4
        col_active = 8
        col_swap = 6
        col_account = max(12, min(18, inner_width // 5))
        col_login = 7
        col_plan = 8
        used = col_cursor + col_number + col_active + col_swap + col_account + col_login + col_plan + 8
        col_usage = max(24, inner_width - used)
        columns = [
            ("", col_cursor),
            ("No.", col_number),
            ("Active", col_active),
            ("Swap", col_swap),
            ("Account", col_account),
            ("Auth", col_login),
            ("Plan", col_plan),
            ("Usage", col_usage),
        ]

        x_positions: list[int] = []
        x = 1
        for _, col_width in columns:
            x_positions.append(x)
            x += col_width + 1

        header_y = section_y + 1
        for (label, col_width), x_pos in zip(columns, x_positions):
            self.stdscr.addnstr(header_y, x_pos, fit_text(label, col_width), col_width, self.colors["header"])
        self.draw_rule(header_y + 1, width - 2)

        if not self.views:
            self.stdscr.addnstr(header_y + 3, 1, "No accounts yet. Press 'a' to add one.", max(1, width - 2), self.colors["muted"])
        else:
            for idx, view in enumerate(self.views):
                row_y = header_y + 2 + idx
                if row_y >= height - 3:
                    break
                selected = idx == self.account_selected_index
                row_attr = self.row_attr(view, selected)
                active_value = "Current" if self.state.active_account == view.account.name else "-"
                login_value = "Y" if view.auth.stored_login else "N"
                values = [
                    ("▌" if selected else " ", self.colors["selection_bar"] if selected else row_attr),
                    (str(idx + 1), row_attr),
                    (active_value, row_attr),
                    ("[x]" if view.account.auto_swap else "[ ]", row_attr),
                    (view.account.name, row_attr),
                    (login_value, row_attr),
                    (view.auth.subscription_type or "-", row_attr),
                    (self.usage_summary(view, col_usage), row_attr),
                ]
                for (value, attr), (_, col_width), x_pos in zip(values, columns, x_positions):
                    self.stdscr.addnstr(row_y, x_pos, fit_text(value, col_width), col_width, attr)

        details_y = min(height - 8, header_y + 4 + len(self.views))
        if details_y + 5 < height - 2:
            selected = self.current_view()
            title_suffix = selected.account.name if selected else "-"
            self.draw_section_title(details_y, width - 2, "DETAILS", title_suffix)
            self.draw_rule(details_y + 1, width - 2)
            for idx, line in enumerate(self.build_selected_summary_lines(width - 2)):
                self.stdscr.addnstr(details_y + 2 + idx, 1, fit_text(line, width - 2), max(1, width - 2), self.colors["muted"])

    def draw_sessions_screen(self, height: int, width: int) -> None:
        section_y = 5
        session_count = len(self.runtime_sessions)
        session_detail = f"showing 1-{session_count} of {session_count}" if session_count else "empty"
        self.draw_section_title(section_y, width - 2, "SESSIONS", session_detail)
        columns = [
            ("", 2),
            ("No.", 4),
            ("Run", 10),
            ("Account", 14),
            ("Session ID", 14),
            ("Replay", 14),
            ("Cwd / Prompt", max(20, width - 52)),
        ]
        x_positions: list[int] = []
        x = 1
        for _, col_width in columns:
            x_positions.append(x)
            x += col_width + 1
        header_y = section_y + 1
        for (label, col_width), x_pos in zip(columns, x_positions):
            self.stdscr.addnstr(header_y, x_pos, fit_text(label, col_width), col_width, self.colors["header"])
        self.draw_rule(header_y + 1, width - 2)

        if not self.runtime_sessions:
            self.stdscr.addnstr(header_y + 3, 1, "No live ccswap sessions.", max(1, width - 2), self.colors["muted"])
        else:
            for idx, item in enumerate(self.runtime_sessions):
                row_y = header_y + 2 + idx
                if row_y >= height - 3:
                    break
                selected = idx == self.session_selected_index
                attr = self.colors["selected_row"] if selected else self.colors["ok"]
                replay = replay_mode_label(item.state.replay_mode)
                session_short = item.state.session_id[:12] if item.state.session_id else "-"
                run_short = item.state.run_id[:8]
                notes = item.state.last_prompt or item.state.custom_prompt or item.state.cwd or "-"
                values = [
                    ("▌" if selected else " ", self.colors["selection_bar"] if selected else attr),
                    (str(idx + 1), attr),
                    (run_short, attr),
                    (item.state.active_account or "-", attr),
                    (session_short, attr),
                    (replay, attr),
                    (notes, attr),
                ]
                for (value, val_attr), (_, col_width), x_pos in zip(values, columns, x_positions):
                    self.stdscr.addnstr(row_y, x_pos, fit_text(value, col_width), col_width, val_attr)

        details_y = min(height - 8, header_y + 4 + len(self.runtime_sessions))
        if details_y + 5 < height - 2:
            selected = self.current_session_view()
            title_suffix = selected.state.run_id[:8] if selected else "-"
            self.draw_section_title(details_y, width - 2, "DETAILS", title_suffix)
            self.draw_rule(details_y + 1, width - 2)
            for idx, line in enumerate(self.build_session_summary_lines(width - 2)):
                self.stdscr.addnstr(details_y + 2 + idx, 1, fit_text(line, width - 2), max(1, width - 2), self.colors["muted"])

    def status_label(self, view: AccountView) -> str:
        if not view.auth.stored_login:
            return "Login missing"
        return "Ready"

    def status_color(self, view: AccountView) -> int:
        if not view.auth.stored_login:
            return self.colors["danger"]
        return self.colors["ok"]

    def row_attr(self, view: AccountView, selected: bool) -> int:
        attr = self.colors["selected_row"] if selected else self.status_color(view)
        if selected:
            attr |= curses.A_BOLD
        return attr

    def notes_label(self, view: AccountView) -> str:
        if not view.auth.stored_login:
            return "Run login"
        return "-"

    def usage_summary(self, view: AccountView, width: int) -> str:
        if not view.auth.stored_login:
            return "login needed"
        parts = [
            f"5h {self.render_usage_bar(view.usage.five_hour_pct, 8)}",
            f"7d {self.render_usage_bar(view.usage.seven_day_pct, 8)}",
        ]
        if view.usage.context_pct is not None:
            parts.append(f"ctx {view.usage.context_pct}%")
        return fit_text("  ".join(parts), width)

    def render_usage_bar(self, value: int | None, width: int) -> str:
        if value is None:
            return "[" + ("-" * width) + "] --"
        filled = max(0, min(width, round((value / 100) * width)))
        return "[" + ("#" * filled) + ("-" * (width - filled)) + f"] {value:>3d}%"

    def build_selected_summary_lines(self, width: int) -> list[str]:
        view = self.current_view()
        if view is None:
            return ["No account selected.", "", "", ""]

        return [
            f"Account: {view.account.name}   Active: {'Yes' if self.state.active_account == view.account.name else 'No'}   Auto-swap: {'Included' if view.account.auto_swap else 'Excluded'}",
            f"Saved login: {'Yes' if view.auth.stored_login else 'No'}   Plan: {view.auth.subscription_type or '-'}",
            f"5h usage: {self.render_usage_bar(view.usage.five_hour_pct, 16)}   Reset: {self.format_usage_reset(view.usage.five_hour_reset_at)}",
            f"7d usage: {self.render_usage_bar(view.usage.seven_day_pct, 16)}   Reset: {self.format_usage_reset(view.usage.seven_day_reset_at)}",
            f"Context: {('--' if view.usage.context_pct is None else str(view.usage.context_pct) + '%')}   Updated: {self.format_usage_updated(view.usage.cache_timestamp_ms)}",
        ]

    def format_usage_reset(self, iso_value: str | None) -> str:
        parsed = _parse_iso(iso_value)
        if parsed is None:
            return "--"
        return parsed.astimezone().strftime("%m-%d %H:%M")

    def format_usage_updated(self, timestamp_ms: int | None) -> str:
        if not timestamp_ms:
            return "--"
        parsed = dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.timezone.utc)
        return parsed.astimezone().strftime("%H:%M:%S")

    def build_session_summary_lines(self, width: int) -> list[str]:
        item = self.current_session_view()
        if item is None:
            return ["No live session selected.", "", "", ""]
        started = item.state.started_at or "-"
        return [
            f"Run ID: {item.state.run_id}",
            f"Session ID: {item.state.session_id or '-'}   Account: {item.state.active_account or '-'}",
            f"Replay mode: {replay_mode_label(item.state.replay_mode)}",
            f"Custom prompt: {item.state.custom_prompt or '-'}",
            f"Last prompt: {item.state.last_prompt or '-'}",
            f"Cwd: {item.state.cwd or '-'}   Started: {started}",
        ]

    def move_selection(self, delta: int) -> None:
        if self.screen_mode == "accounts":
            if not self.views:
                return
            self.account_selected_index = (self.account_selected_index + delta) % len(self.views)
            return
        if not self.runtime_sessions:
            return
        self.session_selected_index = (self.session_selected_index + delta) % len(self.runtime_sessions)

    def select_numeric_account(self, idx: int) -> None:
        if self.screen_mode != "accounts":
            return
        if 0 <= idx < len(self.views):
            self.account_selected_index = idx
            self.message = f"Selected account {self.views[idx].account.name}"

    def current_view(self) -> AccountView | None:
        if not self.views:
            return None
        if not (0 <= self.account_selected_index < len(self.views)):
            return None
        return self.views[self.account_selected_index]

    def current_session_view(self) -> RuntimeSessionView | None:
        if not self.runtime_sessions:
            return None
        if not (0 <= self.session_selected_index < len(self.runtime_sessions)):
            return None
        return self.runtime_sessions[self.session_selected_index]

    def add_account_prompt(self) -> None:
        name = self.prompt("Account name")
        if not name:
            self.message = "Add account cancelled."
            return

        if self.config.get_account(name):
            self.message = f"Account '{name}' already exists."
            return

        account_dir = default_account_dir(name)
        account = Account(name=name, claude_config_dir=str(account_dir), auto_swap=True)
        ensure_account_dir(account)
        self.config.accounts.append(account)
        if not self.state.active_account:
            self.state.active_account = name
        self.config.save()
        self.state.save()
        self.refresh_views()
        self.account_selected_index = max(0, len(self.views) - 1)
        self.message = f"Added account '{name}'. Press 'l' to login and save this account."

    def login_selected(self) -> None:
        view = self.current_view()
        if view is None:
            self.message = "No account selected."
            return
        result = self.run_auth_login_flow(view.account)
        self.refresh_views()
        self.message = result

    def run_auth_login_flow(self, account: Account) -> str:
        curses.def_prog_mode()
        curses.endwin()
        try:
            env = _claude_env()
            result = run_interactive_command_capture(
                [self.config.claude_bin, "auth", "login", "--claudeai"],
                env=env,
                cwd=resolve_launch_cwd(),
                title=f"Login: {account.name}",
            )
            if result.exit_code == 0:
                credential = get_standard_claude_credentials()
                if credential and store_account_credentials(account, credential):
                    self.config.save()
                    return f"Saved login for '{account.name}'."
                return f"Login finished for '{account.name}', but no Claude credentials were captured."
            return f"Login cancelled or failed for '{account.name}' (exit {result.exit_code})."
        finally:
            curses.reset_prog_mode()
            self.stdscr.refresh()

    def set_selected_active(self) -> None:
        view = self.current_view()
        if view is None:
            self.message = "No account selected."
            return
        self.state.active_account = view.account.name
        self.state.last_account = view.account.name
        self.state.save()
        self.message = f"Active account set to '{view.account.name}'."

    def rename_selected(self) -> None:
        view = self.current_view()
        if view is None:
            self.message = "No account selected."
            return
        old_name = view.account.name
        new_name = self.prompt("New account name", old_name)
        if not new_name:
            self.message = "Rename cancelled."
            return
        try:
            rename_account(self.config, self.state, old_name, new_name)
        except ValueError as exc:
            self.message = str(exc)
            return
        self.refresh_views()
        for idx, item in enumerate(self.views):
            if item.account.name == new_name:
                self.account_selected_index = idx
                break
        self.message = f"Renamed '{old_name}' to '{new_name}'."

    def toggle_selected_enabled(self) -> None:
        view = self.current_view()
        if view is None:
            self.message = "No account selected."
            return
        view.account.auto_swap = not view.account.auto_swap
        self.config.save()
        self.refresh_views()
        self.message = f"{view.account.name} {'included in' if view.account.auto_swap else 'excluded from'} auto-swap."

    def delete_selected(self) -> None:
        view = self.current_view()
        if view is None:
            self.message = "No account selected."
            return
        if not self.confirm_dialog(
            title=" Delete Account ",
            lines=[
                f"Delete account '{view.account.name}'?",
                "",
                "Saved login snapshot will be removed.",
                "Press y to delete or n to cancel.",
            ],
        ):
            self.message = "Delete cancelled."
            return

        delete_account_credentials(view.account)
        remove_account_usage_cache(view.account)
        self.config.accounts = [account for account in self.config.accounts if account.name != view.account.name]
        self.config.save()
        if self.state.active_account == view.account.name:
            self.state.active_account = self.config.accounts[0].name if self.config.accounts else None
        if self.state.last_account == view.account.name:
            self.state.last_account = None
        self.state.save()
        self.refresh_views()
        self.message = f"Deleted '{view.account.name}'."

    def launch_claude(self, extra_args: list[str]) -> None:
        if not self.config.accounts:
            self.message = "No accounts configured."
            return
        exit_code = run_claude_session(
            self.config,
            self.state,
            extra_args,
            launch_cwd=current_session_cwd(),
        )
        self.refresh_views()
        self.message = f"Claude session finished with exit code {exit_code}."

    def show_help(self) -> None:
        lines = [
            "CCSWAP keys",
            "",
            "j/k or arrows: move selection",
            "Tab: switch between Accounts and Sessions",
            "a: add account row",
            "l: login with Claude and save the selected account",
            "r: rename selected account",
            "Enter: make selected account active",
            "space: include/exclude selected account from auto-swap",
            "d: delete selected account",
            "s: open session settings (Sessions screen)",
            "1-9: jump to account row",
            "q: quit",
        ]
        self.show_modal(lines)

    def open_settings_panel(self) -> None:
        self.open_session_settings_panel()

    def open_session_settings_panel(self) -> None:
        while True:
            lines = [
                "Session settings",
                "",
                f"m  Cycle replay mode (currently: {replay_mode_label(self.config.replay_mode)})",
                f"p  Set custom replay prompt ({'set' if self.config.custom_prompt else 'empty'})",
                "x  Run Claude now",
                "r  Run Claude with extra args",
                "",
                "Press q or Esc to close",
            ]
            key = self.show_menu(lines, title=" Session Settings ")
            if key in (ord("q"), 27):
                self.message = "Closed session settings."
                return
            if key == ord("m"):
                current_index = REPLAY_MODES.index(self.config.replay_mode)
                self.config.replay_mode = REPLAY_MODES[(current_index + 1) % len(REPLAY_MODES)]
                self.config.save()
                self.message = f"Replay mode set to {replay_mode_label(self.config.replay_mode)}."
            elif key == ord("p"):
                prompt = self.prompt("Custom replay prompt", self.config.custom_prompt)
                self.config.custom_prompt = prompt or ""
                self.config.save()
                self.message = "Updated custom replay prompt."
            elif key == ord("x"):
                self.launch_claude([])
            elif key == ord("r"):
                args = self.prompt("Claude args", "--model sonnet")
                if args is not None:
                    self.launch_claude(shlex.split(args))

    def show_modal(self, lines: list[str]) -> None:
        height, width = self.stdscr.getmaxyx()
        wrapped: list[str] = []
        for line in lines:
            wrapped.extend(textwrap.wrap(line, max(10, width - 8)) or [""])
        box_h = min(height - 4, len(wrapped) + 4)
        box_w = min(width - 4, max(len(line) for line in wrapped) + 4 if wrapped else 20)
        start_y = max(2, (height - box_h) // 2)
        start_x = max(2, (width - box_w) // 2)
        win = curses.newwin(box_h, box_w, start_y, start_x)
        win.box()
        for idx, line in enumerate(wrapped[: box_h - 3]):
            win.addnstr(1 + idx, 2, line, box_w - 4)
        win.addnstr(box_h - 2, 2, "Press any key", box_w - 4, curses.A_DIM)
        win.refresh()
        win.getch()

    def confirm_dialog(self, title: str, lines: list[str]) -> bool:
        height, width = self.stdscr.getmaxyx()
        wrapped: list[str] = []
        for line in lines:
            wrapped.extend(textwrap.wrap(line, max(10, width - 8)) or [""])
        box_h = min(height - 4, len(wrapped) + 4)
        box_w = min(width - 4, max(len(line) for line in wrapped) + 4 if wrapped else 24)
        start_y = max(2, (height - box_h) // 2)
        start_x = max(2, (width - box_w) // 2)
        win = curses.newwin(box_h, box_w, start_y, start_x)
        win.keypad(True)
        win.box()
        win.addnstr(0, 2, title, max(1, box_w - 4), self.colors["title"])
        for idx, line in enumerate(wrapped[: box_h - 3]):
            attr = self.colors["danger"] if "delete" in line.lower() else self.colors["muted"]
            win.addnstr(1 + idx, 2, line, box_w - 4, attr)
        win.refresh()
        while True:
            key = win.getch()
            if key in (ord("y"), ord("Y")):
                return True
            if key in (ord("n"), ord("N"), 27):
                return False

    def show_menu(self, lines: list[str], title: str = " Menu ") -> int:
        height, width = self.stdscr.getmaxyx()
        menu_rows: list[tuple[str, str | None]] = []
        key_width = 0
        for line in lines:
            if "  " in line and len(line.strip()) > 3:
                key, desc = line.split("  ", 1)
                key = key.strip()
                desc = desc.strip()
                key_width = max(key_width, len(key))
                menu_rows.append((key, desc))
            else:
                menu_rows.append((line, None))

        key_width = max(6, min(14, key_width))
        content_width = max(28, width - 14)
        desc_width = max(18, content_width - key_width - 3)

        rendered_rows: list[tuple[str, str | None]] = []
        for key, desc in menu_rows:
            if desc is None:
                wrapped = textwrap.wrap(key, content_width) or [""]
                rendered_rows.extend((chunk, None) for chunk in wrapped)
                continue
            wrapped_desc = textwrap.wrap(desc, desc_width) or [""]
            rendered_rows.append((key, wrapped_desc[0]))
            for chunk in wrapped_desc[1:]:
                rendered_rows.append(("", chunk))

        box_h = min(height - 4, len(rendered_rows) + 4)
        box_w = min(width - 4, key_width + desc_width + 7)
        start_y = max(2, (height - box_h) // 2)
        start_x = max(2, (width - box_w) // 2)
        win = curses.newwin(box_h, box_w, start_y, start_x)
        win.keypad(True)
        win.box()
        win.addnstr(0, 2, title, max(1, box_w - 4), self.colors["title"])
        row = 1
        for key, desc in rendered_rows[: box_h - 3]:
            if desc is not None:
                if key:
                    win.addnstr(row, 2, fit_text(key, key_width), key_width, self.colors["accent"])
                win.addnstr(row, 3 + key_width, fit_text(desc, box_w - key_width - 5), max(1, box_w - key_width - 5), self.colors["muted"])
            else:
                win.addnstr(row, 2, fit_text(key, box_w - 4), box_w - 4, self.colors["muted"])
            row += 1
        win.refresh()
        return win.getch()

    def draw_section_title(self, y: int, width: int, title: str, detail: str = "") -> None:
        self.stdscr.addnstr(y, 1, title, max(1, width), self.colors["title"])
        if detail:
            offset = min(width - 2, len(title) + 3)
            self.stdscr.addnstr(y, 1 + offset, fit_text(detail, max(1, width - offset)), max(1, width - offset), self.colors["muted"])

    def draw_rule(self, y: int, width: int) -> None:
        self.stdscr.addnstr(y, 1, "-" * max(1, width), max(1, width), self.colors["muted"])

    def draw_shortcuts(self, y: int, x: int, width: int, shortcuts: list[tuple[str, str]], prefix: str = "") -> None:
        cursor_x = x
        max_x = x + max(1, width)
        if prefix:
            self.stdscr.addnstr(y, cursor_x, prefix, max_x - cursor_x, self.colors["muted"])
            cursor_x += len(prefix)
        for key, label in shortcuts:
            chunk = f"{key} "
            if cursor_x >= max_x - 4:
                break
            self.stdscr.addnstr(y, cursor_x, chunk, max_x - cursor_x, self.colors["accent"])
            cursor_x += len(chunk)
            label_chunk = f"{label}   "
            if cursor_x >= max_x - 2:
                break
            self.stdscr.addnstr(y, cursor_x, label_chunk, max_x - cursor_x, self.colors["muted"])
            cursor_x += len(label_chunk)

    def prompt(
        self,
        label: str,
        default: str = "",
        secret: bool = False,
        placeholder: str = "",
    ) -> str | None:
        _safe_curs_set(1)
        if secret:
            curses.noecho()
        else:
            curses.echo()
        try:
            height, width = self.stdscr.getmaxyx()
            prompt = f"{label}: "
            self.stdscr.move(height - 1, 0)
            self.stdscr.clrtoeol()
            self.stdscr.addnstr(height - 1, 0, prompt, width - 1)
            preview = placeholder if secret else default
            if preview:
                attr = self.colors["muted"] if secret else curses.A_NORMAL
                self.stdscr.addnstr(height - 1, len(prompt), preview, width - len(prompt) - 1, attr)
                self.stdscr.move(height - 1, len(prompt))
            elif default:
                self.stdscr.addnstr(height - 1, len(prompt), default, width - len(prompt) - 1)
                self.stdscr.move(height - 1, len(prompt) + len(default))
            self.stdscr.refresh()
            raw = self.stdscr.getstr(height - 1, len(prompt), max(1, width - len(prompt) - 1))
            value = raw.decode("utf-8", errors="ignore").strip()
            if not value:
                value = default.strip()
            return value or None
        finally:
            curses.noecho()
            _safe_curs_set(0)

    def run_external(self, cmd: list[str], env: dict[str, str], title: str) -> int:
        curses.def_prog_mode()
        curses.endwin()
        try:
            print(f"[ccswap] {title}")
            print(f"[ccswap] {' '.join(shlex.quote(part) for part in cmd)}")
            result = subprocess.run(
                cmd,
                env=env,
                cwd=resolve_launch_cwd(env.get("CLAUDE_CONFIG_DIR")),
            )
            input("[ccswap] Press Enter to return to dashboard...")
            return int(result.returncode)
        finally:
            curses.reset_prog_mode()
            self.stdscr.refresh()


def ensure_account_dir(account: Account) -> None:
    path = Path(account.claude_config_dir)
    for sub in ("", "logs", "projects", "todos", "shell-snapshots", "file-history", "debug", "session-env"):
        target = path / sub if sub else path
        target.mkdir(parents=True, exist_ok=True)


def default_account_dir(name: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-") or "account"
    return ACCOUNTS_DIR / safe / "claude"


def get_auth_status(account: Account, claude_bin: str) -> AuthStatus:
    ensure_account_dir(account)
    credential = get_account_credentials(account)
    if credential is not None:
        parsed = parse_stored_credential(credential.secret)
        return AuthStatus(
            logged_in=True,
            auth_method="claude_login",
            subscription_type=parsed.get("subscription_type"),
            error=None,
            stored_login=True,
        )
    return AuthStatus(
        logged_in=False,
        auth_method="claude_login",
        error="No saved login",
        stored_login=False,
    )


def prepare_account_auth(account: Account) -> tuple[bool, str, str | None]:
    if activate_account_credentials(account):
        return True, "keychain", None
    return False, "missing", None


def refresh_account_usage(account: Account, force: bool = False) -> bool:
    credential = get_account_credentials(account)
    if credential is None:
        return False
    parsed = parse_stored_credential(credential.secret)
    access_token = str(parsed.get("access_token") or "")
    subscription_type = str(parsed.get("subscription_type") or "")
    return _refresh_usage_cache(
        account_usage_cache_path(account),
        account_usage_lock_path(account),
        access_token,
        subscription_type,
        force=force,
        env=os.environ,
    )


def is_account_usage_exhausted(account: Account, force_refresh: bool = False) -> bool:
    if force_refresh:
        refresh_account_usage(account, force=True)
    snapshot = load_account_usage(account)
    return snapshot.five_hour_pct == 100 or snapshot.seven_day_pct == 100


def run_claude_session(
    config: AppConfig,
    state: AppState,
    original_args: list[str],
    launch_cwd: str | None = None,
) -> int:
    def _handle_session_hint(run_id: str, state_path: Path, session_id: str) -> None:
        update_runtime_state(state_path, run_id, session_id=session_id)

    def _should_arm_limit(state_path: Path, run_id: str) -> bool:
        runtime_state = SessionRuntimeState.load(state_path, run_id)
        return runtime_state.detector_armed

    cleanup_stale_runtime_sessions()
    accounts = [account for account in config.accounts if get_account_credentials(account)]
    if not accounts:
        print("[ccswap] No accounts with saved logins configured.", file=sys.stderr)
        return 1
    session_cwd = resolve_session_cwd(launch_cwd)
    log_event(
        "session start "
        f"active={state.active_account or '-'} "
        f"last={state.last_account or '-'} "
        f"accounts={[account.name for account in accounts]} "
        f"cwd={session_cwd}"
    )

    current_name = state.active_account or _pick_launch_account_name(accounts, state)
    if not current_name:
        print("[ccswap] No eligible account is available.", file=sys.stderr)
        return 1

    run_id = str(uuid.uuid4())
    session_state_path = runtime_state_path(run_id)
    runtime_state = SessionRuntimeState(
        run_id=run_id,
        cwd=session_cwd,
        active_account=current_name,
        replay_mode=config.replay_mode,
        custom_prompt=config.custom_prompt or None,
        started_at=dt.datetime.now(dt.timezone.utc).isoformat(),
    )
    runtime_state.save(session_state_path)
    launch_args, settings_path = inject_runtime_settings(original_args, run_id, session_state_path)
    attempted: set[str] = set()

    try:
        while True:
            account = next((item for item in accounts if item.name == current_name), None)
            if account is None:
                print(f"[ccswap] Missing account '{current_name}'.", file=sys.stderr)
                return 1

            _, launch_prompt = _split_prompt_from_args(launch_args)
            detector_armed = bool(launch_prompt and not launch_prompt.lstrip().startswith("/"))

            state.active_account = account.name
            state.last_account = account.name
            state.save()
            update_runtime_state(
                session_state_path,
                run_id,
                cwd=session_cwd,
                active_account=account.name,
                replay_mode=config.replay_mode,
                custom_prompt=config.custom_prompt or None,
                detector_armed=detector_armed,
            )

            auth_ready, auth_mode, runtime_config_dir = prepare_account_auth(account)
            if not auth_ready:
                print(
                    f"[ccswap] Account '{account.name}' has no saved Claude login. Use 'l' in the dashboard or 'ccswap login {account.name}'.",
                    file=sys.stderr,
                )
                log_event(f"launch blocked account={account.name} reason=no_saved_login")
                return 1

            print(
                f"[ccswap] Launching Claude with '{account.name}' in {session_cwd}",
                file=sys.stderr,
            )
            log_event(
                f"launch account={account.name} cwd={session_cwd} auth_mode={auth_mode} config_dir={runtime_config_dir} args={launch_args!r}"
            )
            runner = ClaudeRunner(
                config.claude_bin,
                account,
                launch_args,
                session_cwd,
                claude_config_dir=runtime_config_dir,
            )
            result = runner.run(
                on_started=lambda pid: update_runtime_state(
                    session_state_path,
                    run_id,
                    claude_pid=pid,
                    active_account=account.name,
                ),
                on_session_hint=lambda session_id: _handle_session_hint(run_id, session_state_path, session_id),
                should_arm_limit=lambda: _should_arm_limit(session_state_path, run_id),
                should_confirm_limit=lambda: is_account_usage_exhausted(account, force_refresh=True),
            )

            if not result.limit_hit:
                log_event(
                    f"session end account={account.name} exit_code={result.exit_code} "
                    f"limit_hit={result.limit_hit}"
                )
                return result.exit_code

            attempted.add(account.name)
            log_event(f"limit account={account.name} attempted={sorted(attempted)!r}")

            next_name = _pick_account_name(accounts, state, exclude=attempted)
            if not next_name:
                print(
                    f"[ccswap] '{account.name}' hit its limit and no backup account is ready.",
                    file=sys.stderr,
                )
                log_event(f"no backup available after account={account.name}")
                return 1

            runtime_state = SessionRuntimeState.load(session_state_path, run_id)
            launch_args = _build_resume_args(
                original_args,
                runtime_state,
                disable_auto_continue=False,
            )
            print(f"[ccswap] Switching to '{next_name}'", file=sys.stderr)
            log_event(
                f"switching from={account.name} to={next_name} session_id={runtime_state.session_id or '-'} "
                f"prompt_present={bool(runtime_state.last_prompt)}"
            )
            state.active_account = next_name
            state.save()
            current_name = next_name
    finally:
        for path in (session_state_path, settings_path):
            try:
                path.unlink()
            except OSError:
                pass


def cmd_init(args: argparse.Namespace) -> int:
    config = AppConfig.load()
    config.save()
    state = AppState.load()
    state.save()
    print(f"Initialized {CONFIG_PATH}")
    return 0


def cmd_account_add(args: argparse.Namespace) -> int:
    config = AppConfig.load()
    state = AppState.load()
    if config.get_account(args.name):
        print(f"Account '{args.name}' already exists.", file=sys.stderr)
        return 1
    account = Account(
        name=args.name,
        claude_config_dir=str(default_account_dir(args.name)),
        auto_swap=True,
        keychain_service=default_keychain_service(args.name),
        keychain_account=default_keychain_account(),
    )
    ensure_account_dir(account)
    config.accounts.append(account)
    config.save()
    if not state.active_account:
        state.active_account = account.name
        state.last_account = account.name
        state.save()
    print(f"Added account '{args.name}' at {account.claude_config_dir}")
    print("Save a Claude login with: ccswap login <name>")
    return 0


def cmd_account_rename(args: argparse.Namespace) -> int:
    config = AppConfig.load()
    state = AppState.load()
    try:
        rename_account(config, state, args.old_name, args.new_name)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"Renamed '{args.old_name}' to '{args.new_name}'.")
    return 0


def cmd_account_list(_args: argparse.Namespace) -> int:
    config = AppConfig.load()
    state = AppState.load()
    state.save()
    if not config.accounts:
        print("No accounts configured.")
        return 0

    for account in config.accounts:
        auth = get_auth_status(account, config.claude_bin)
        usage = load_account_usage(account)
        active = "*" if state.active_account == account.name else " "
        print(
            f"{active} {account.name}: auto_swap={account.auto_swap} login_saved={auth.stored_login}"
            f" sub={auth.subscription_type or '-'} 5h={usage.five_hour_pct if usage.five_hour_pct is not None else '--'}"
            f" 7d={usage.seven_day_pct if usage.seven_day_pct is not None else '--'}"
        )
    return 0


def cmd_login(args: argparse.Namespace) -> int:
    config = AppConfig.load()
    account = config.get_account(args.name)
    if account is None:
        print(f"Account '{args.name}' not found.", file=sys.stderr)
        return 1
    env = _claude_env()
    result = run_interactive_command_capture(
        [config.claude_bin, "auth", "login", "--claudeai"],
        env=env,
        cwd=resolve_launch_cwd(),
        title=f"Login: {account.name}",
    )
    if result.exit_code != 0:
        print(f"Login cancelled or failed for '{account.name}'.", file=sys.stderr)
        return result.exit_code or 1
    credential = get_standard_claude_credentials()
    if credential is None or not store_account_credentials(account, credential):
        print("Login succeeded but no Claude Code credentials were captured.", file=sys.stderr)
        return 1
    config.save()
    print(f"Saved login for '{account.name}'.")
    return 0


def cmd_use(args: argparse.Namespace) -> int:
    config = AppConfig.load()
    state = AppState.load()
    account = config.get_account(args.name)
    if account is None:
        print(f"Account '{args.name}' not found.", file=sys.stderr)
        return 1
    state.active_account = account.name
    state.last_account = account.name
    state.save()
    print(f"Active account set to '{account.name}'.")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    config = AppConfig.load()
    state = AppState.load()
    if args.account:
        state.active_account = args.account
        state.save()
    raw_args = list(args.claude_args or [])
    if raw_args and raw_args[0] == "--":
        raw_args = raw_args[1:]
    return run_claude_session(config, state, raw_args, launch_cwd=current_session_cwd())


def cmd_dashboard(_args: argparse.Namespace) -> int:
    config = AppConfig.load()
    state = AppState.load()
    safe_cwd = resolve_launch_cwd(current_session_cwd())
    try:
        os.chdir(safe_cwd)
    except OSError:
        pass

    def _inner(stdscr: "curses._CursesWindow") -> int:
        return Dashboard(stdscr, config, state).run()

    return int(curses.wrapper(_inner))


def _read_hook_payload() -> dict:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def cmd_hook_session_start(args: argparse.Namespace) -> int:
    payload = _read_hook_payload()
    state_path = Path(args.state_path)
    update_runtime_state(
        state_path,
        args.run_id,
        session_id=str(payload["session_id"]) if payload.get("session_id") else None,
        cwd=str(payload["cwd"]) if payload.get("cwd") else None,
    )
    return 0


def cmd_hook_prompt_submit(args: argparse.Namespace) -> int:
    payload = _read_hook_payload()
    prompt = payload.get("prompt")
    prompt_text = str(prompt) if prompt else None
    detector_armed = bool(prompt_text and not prompt_text.lstrip().startswith("/"))
    update_runtime_state(
        Path(args.state_path),
        args.run_id,
        session_id=str(payload["session_id"]) if payload.get("session_id") else None,
        cwd=str(payload["cwd"]) if payload.get("cwd") else None,
        last_prompt=prompt_text,
        last_prompt_at=dt.datetime.now(dt.timezone.utc).isoformat(),
        detector_armed=detector_armed,
    )
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Claude Code multi-account dashboard / auto-swap wrapper")
    subparsers = parser.add_subparsers(dest="command", required=False)

    init_parser = subparsers.add_parser("init", help="Initialize config/state files")
    init_parser.set_defaults(func=cmd_init)

    account_parser = subparsers.add_parser("account", help="Manage account rows")
    account_subparsers = account_parser.add_subparsers(dest="account_command", required=True)
    account_add = account_subparsers.add_parser("add", help="Add a new account row")
    account_add.add_argument("name")
    account_add.set_defaults(func=cmd_account_add)
    account_rename = account_subparsers.add_parser("rename", help="Rename an account row")
    account_rename.add_argument("old_name")
    account_rename.add_argument("new_name")
    account_rename.set_defaults(func=cmd_account_rename)
    account_list = account_subparsers.add_parser("list", help="List accounts")
    account_list.set_defaults(func=cmd_account_list)

    login_parser = subparsers.add_parser("login", help="Login with Claude and save this account's keychain credentials")
    login_parser.add_argument("name")
    login_parser.set_defaults(func=cmd_login)

    use_parser = subparsers.add_parser("use", help="Set the active account")
    use_parser.add_argument("name")
    use_parser.set_defaults(func=cmd_use)

    run_parser = subparsers.add_parser("run", help="Run Claude through ccswap")
    run_parser.add_argument("--account", help="Force this account as the initial active one")
    run_parser.add_argument("claude_args", nargs=argparse.REMAINDER)
    run_parser.set_defaults(func=cmd_run)

    dashboard_parser = subparsers.add_parser("dashboard", help="Open the interactive dashboard")
    dashboard_parser.set_defaults(func=cmd_dashboard)

    hook_parser = subparsers.add_parser("hook", help=argparse.SUPPRESS)
    hook_subparsers = hook_parser.add_subparsers(dest="hook_command", required=True)
    hook_session_start = hook_subparsers.add_parser("session-start", help=argparse.SUPPRESS)
    hook_session_start.add_argument("--run-id", required=True)
    hook_session_start.add_argument("--state-path", required=True)
    hook_session_start.set_defaults(func=cmd_hook_session_start)
    hook_prompt_submit = hook_subparsers.add_parser("prompt-submit", help=argparse.SUPPRESS)
    hook_prompt_submit.add_argument("--run-id", required=True)
    hook_prompt_submit.add_argument("--state-path", required=True)
    hook_prompt_submit.set_defaults(func=cmd_hook_prompt_submit)

    parser.set_defaults(func=cmd_dashboard)
    return parser


def _build_resume_args(
    original_args: list[str],
    runtime_state: SessionRuntimeState,
    disable_auto_continue: bool,
) -> list[str]:
    if disable_auto_continue:
        return original_args
    if any(arg in {"-p", "--print"} for arg in original_args):
        return original_args
    session_id = runtime_state.session_id
    if not session_id:
        return original_args

    filtered_args, original_prompt = _split_prompt_from_args(original_args)
    resume_filtered_args: list[str] = []
    skip_next = False
    for idx, arg in enumerate(filtered_args):
        if skip_next:
            skip_next = False
            continue
        if arg in {"-c", "--continue"}:
            continue
        if arg in {"-r", "--resume", "--session-id"} and idx + 1 < len(filtered_args):
            skip_next = True
            continue
        resume_filtered_args.append(arg)

    resume_args = ["--resume", session_id, *resume_filtered_args]
    replay_mode = runtime_state.replay_mode if runtime_state.replay_mode in REPLAY_MODES else "last_prompt"
    prompt_to_send: str | None = None
    if replay_mode == "last_prompt":
        prompt_to_send = runtime_state.last_prompt or original_prompt
    elif replay_mode == "custom_prompt":
        prompt_to_send = runtime_state.custom_prompt
    if prompt_to_send:
        resume_args.append(prompt_to_send)
    return resume_args


def _split_prompt_from_args(args: list[str]) -> tuple[list[str], str | None]:
    if not args:
        return [], None
    tokens = list(args)
    result: list[str] = []
    positional: list[str] = []
    expect_value = False
    for token in tokens:
        if expect_value:
            result.append(token)
            expect_value = False
            continue
        if token == "--":
            result.append(token)
            continue
        if token.startswith("-"):
            result.append(token)
            if token in OPTIONS_WITH_VALUE or "=" not in token and token.startswith("--") and token.split("=")[0] in OPTIONS_WITH_VALUE:
                expect_value = "=" not in token
            continue
        positional.append(token)
        result.append(token)
    if not positional:
        return result, None
    prompt = positional[-1]
    for idx in range(len(result) - 1, -1, -1):
        if result[idx] == prompt:
            del result[idx]
            break
    return result, prompt


def normalize_cli_args(argv: list[str]) -> list[str]:
    if not argv:
        return argv
    if argv[0] != "claude":
        return argv
    if len(argv) == 1:
        return ["run"]
    return ["run", "--", *argv[1:]]


def _pick_launch_account_name(accounts: Iterable[Account], state: AppState) -> str | None:
    ordered = list(accounts)
    pivot = state.active_account or state.last_account
    if pivot:
        pivot_index = next((idx for idx, account in enumerate(ordered) if account.name == pivot), None)
        if pivot_index is not None:
            return ordered[pivot_index].name
    return ordered[0].name if ordered else None


def _pick_account_name(accounts: Iterable[Account], state: AppState, exclude: set[str]) -> str | None:
    ordered = list(accounts)

    pivot = state.active_account or state.last_account
    if pivot:
        pivot_index = next((idx for idx, account in enumerate(ordered) if account.name == pivot), None)
        if pivot_index is not None:
            ordered = ordered[pivot_index + 1 :] + ordered[: pivot_index + 1]

    for account in ordered:
        if account.name in exclude or not account.auto_swap:
            continue
        return account.name
    return None


def rename_account(config: AppConfig, state: AppState, old_name: str, new_name: str) -> None:
    new_name = new_name.strip()
    if not new_name:
        raise ValueError("New account name cannot be empty.")
    if old_name == new_name:
        raise ValueError("New account name is the same as the current name.")
    account = config.get_account(old_name)
    if account is None:
        raise ValueError(f"Account '{old_name}' not found.")
    if config.get_account(new_name):
        raise ValueError(f"Account '{new_name}' already exists.")

    account.name = new_name
    if state.active_account == old_name:
        state.active_account = new_name
    if state.last_account == old_name:
        state.last_account = new_name

    config.save()
    state.save()


def _claude_env(claude_config_dir: str | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if claude_config_dir:
        env["CLAUDE_CONFIG_DIR"] = claude_config_dir
    else:
        env.pop("CLAUDE_CONFIG_DIR", None)
    env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env


def current_session_cwd() -> str | None:
    try:
        return os.getcwd()
    except OSError:
        return None


def resolve_session_cwd(preferred: str | None = None) -> str:
    candidates: list[str | None] = [preferred]
    candidates.extend([os.environ.get("HOME"), str(Path.home()), "/tmp"])
    for candidate in candidates:
        if not candidate:
            continue
        try:
            path = Path(candidate).expanduser().resolve()
        except OSError:
            continue
        if path.exists() and path.is_dir() and os.access(path, os.R_OK | os.X_OK):
            return str(path)
    return "/tmp"


def resolve_launch_cwd(preferred: str | None = None) -> str:
    candidates = [preferred, os.environ.get("HOME"), str(Path.home()), "/tmp"]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            path = Path(candidate).expanduser().resolve()
        except OSError:
            continue
        if path.exists() and path.is_dir() and os.access(path, os.R_OK | os.X_OK):
            return str(path)
    return "/tmp"


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _load_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def file_mtime_ns(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


def _parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _get_winsize(fd: int) -> tuple[int, int]:
    packed = struct.pack("HHHH", 0, 0, 0, 0)
    result = fcntl_ioctl(fd, termios.TIOCGWINSZ, packed)
    rows, cols, _, _ = struct.unpack("HHHH", result)
    return rows or 24, cols or 80


def _ioctl_set_winsize(fd: int, payload: bytes) -> None:
    try:
        fcntl_ioctl(fd, termios.TIOCSWINSZ, payload)
    except OSError:
        pass


def fcntl_ioctl(fd: int, op: int, data: bytes) -> bytes:
    import fcntl

    return fcntl.ioctl(fd, op, data)


def _safe_curs_set(value: int) -> None:
    try:
        curses.curs_set(value)
    except curses.error:
        pass


def fit_text(value: str, width: int) -> str:
    if width <= 0:
        return ""
    value = str(value)
    if len(value) <= width:
        return value.ljust(width)
    if width == 1:
        return value[:1]
    return value[: width - 1] + "…"


def format_remaining(delta: dt.timedelta) -> str:
    total_seconds = max(0, int(delta.total_seconds()))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, _ = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}h {minutes}m"
    return f"{minutes}m"


def main(argv: list[str] | None = None) -> int:
    argv = normalize_cli_args(list(argv) if argv is not None else sys.argv[1:])
    parser = _build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
