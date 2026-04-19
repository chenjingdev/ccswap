from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


def _load_json(path: Path, default: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def file_mtime_ns(path: Path) -> int | None:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return None


@dataclass
class SessionRuntimeState:
    run_id: str
    session_id: str | None = None
    last_prompt: str | None = None
    last_prompt_at: str | None = None
    detector_armed: bool = False
    cwd: str | None = None
    active_account: str | None = None
    replay_mode: str = "last_prompt"
    custom_prompt: str | None = None
    started_at: str | None = None
    claude_pid: int | None = None

    @classmethod
    def load(cls, path: Path, run_id: str) -> "SessionRuntimeState":
        data = _load_json(path, {"run_id": run_id})
        return cls(
            run_id=str(data.get("run_id") or run_id),
            session_id=str(data["session_id"]) if data.get("session_id") else None,
            last_prompt=str(data["last_prompt"]) if data.get("last_prompt") else None,
            last_prompt_at=str(data["last_prompt_at"]) if data.get("last_prompt_at") else None,
            detector_armed=bool(data.get("detector_armed", False)),
            cwd=str(data["cwd"]) if data.get("cwd") else None,
            active_account=str(data["active_account"]) if data.get("active_account") else None,
            replay_mode=str(data.get("replay_mode") or "last_prompt"),
            custom_prompt=str(data["custom_prompt"]) if data.get("custom_prompt") else None,
            started_at=str(data["started_at"]) if data.get("started_at") else None,
            claude_pid=int(data["claude_pid"]) if data.get("claude_pid") else None,
        )

    def save(self, path: Path) -> None:
        _ensure_dir(path.parent)
        path.write_text(
            json.dumps(
                {
                    "run_id": self.run_id,
                    "session_id": self.session_id,
                    "last_prompt": self.last_prompt,
                    "last_prompt_at": self.last_prompt_at,
                    "detector_armed": self.detector_armed,
                    "cwd": self.cwd,
                    "active_account": self.active_account,
                    "replay_mode": self.replay_mode,
                    "custom_prompt": self.custom_prompt,
                    "started_at": self.started_at,
                    "claude_pid": self.claude_pid,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        os.chmod(path, 0o600)


@dataclass
class RuntimeSessionView:
    path: Path
    state: SessionRuntimeState


def runtime_state_path(runtime_dir: Path, run_id: str) -> Path:
    return runtime_dir / f"{run_id}.json"


def runtime_settings_path(runtime_dir: Path, run_id: str) -> Path:
    return runtime_dir / f"{run_id}.settings.json"


def update_runtime_state(
    path: Path,
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
    state = SessionRuntimeState.load(path, run_id)
    if session_id is not None:
        state.session_id = session_id
    if last_prompt is not None:
        state.last_prompt = last_prompt
    if last_prompt_at is not None:
        state.last_prompt_at = last_prompt_at
    if detector_armed is not None:
        state.detector_armed = detector_armed
    if cwd is not None:
        state.cwd = cwd
    if active_account is not None:
        state.active_account = active_account
    if replay_mode is not None:
        state.replay_mode = replay_mode
    if custom_prompt is not None:
        state.custom_prompt = custom_prompt
    if started_at is not None:
        state.started_at = started_at
    if claude_pid is not None:
        state.claude_pid = claude_pid
    state.save(path)
    return state


def _remove_runtime_artifacts(runtime_dir: Path, run_id: str) -> None:
    for path in (runtime_state_path(runtime_dir, run_id), runtime_settings_path(runtime_dir, run_id)):
        try:
            path.unlink()
        except OSError:
            pass


def cleanup_stale_runtime_sessions(runtime_dir: Path, process_is_alive: Callable[[int | None], bool]) -> None:
    if not runtime_dir.exists():
        return
    now = time.time()
    for path in sorted(runtime_dir.glob("*.json")):
        if path.name.endswith(".settings.json"):
            continue
        run_id = path.stem
        state = SessionRuntimeState.load(path, run_id)
        if process_is_alive(state.claude_pid):
            continue
        age_seconds = max(0.0, now - path.stat().st_mtime)
        if state.claude_pid is None and age_seconds < 15:
            continue
        _remove_runtime_artifacts(runtime_dir, run_id)


def runtime_dir_stamp(runtime_dir: Path, process_is_alive: Callable[[int | None], bool]) -> tuple[int, int]:
    cleanup_stale_runtime_sessions(runtime_dir, process_is_alive)
    if not runtime_dir.exists():
        return (0, 0)
    files = sorted(runtime_dir.glob("*.json"))
    latest = 0
    count = 0
    for path in files:
        if path.name.endswith(".settings.json"):
            continue
        count += 1
        latest = max(latest, file_mtime_ns(path) or 0)
    return (count, latest)


def list_runtime_sessions(runtime_dir: Path, process_is_alive: Callable[[int | None], bool]) -> list[RuntimeSessionView]:
    cleanup_stale_runtime_sessions(runtime_dir, process_is_alive)
    if not runtime_dir.exists():
        return []
    sessions: list[RuntimeSessionView] = []
    for path in sorted(runtime_dir.glob("*.json")):
        if path.name.endswith(".settings.json"):
            continue
        run_id = path.stem
        state = SessionRuntimeState.load(path, run_id)
        sessions.append(RuntimeSessionView(path=path, state=state))
    sessions.sort(key=lambda item: item.path.stat().st_mtime_ns if item.path.exists() else 0, reverse=True)
    return sessions
