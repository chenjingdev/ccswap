import datetime as dt
import tempfile
import unittest

import importlib.util
from pathlib import Path
import sys


MODULE_PATH = Path("/Users/chenjing/dev/ccswap/ccswap.py")
sys.path.insert(0, str(MODULE_PATH.parent))
SPEC = importlib.util.spec_from_file_location("ccswap", MODULE_PATH)
ccswap = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules["ccswap"] = ccswap
SPEC.loader.exec_module(ccswap)


class BuildResumeArgsTests(unittest.TestCase):
    def test_resume_reuses_session_id_and_last_prompt(self):
        state = ccswap.SessionRuntimeState(
            run_id="run-1",
            session_id="550e8400-e29b-41d4-a716-446655440000",
            last_prompt="keep going",
        )
        self.assertEqual(
            ccswap._build_resume_args(["--model", "sonnet"], state, False),
            ["--resume", "550e8400-e29b-41d4-a716-446655440000", "--model", "sonnet", "keep going"],
        )

    def test_non_interactive_flags_are_preserved(self):
        state = ccswap.SessionRuntimeState(run_id="run-1", session_id="id", last_prompt="hi")
        self.assertEqual(ccswap._build_resume_args(["-p", "hi"], state, False), ["-p", "hi"])

    def test_missing_session_id_keeps_original_args(self):
        state = ccswap.SessionRuntimeState(run_id="run-1")
        self.assertEqual(ccswap._build_resume_args(["--model", "sonnet"], state, False), ["--model", "sonnet"])

    def test_existing_prompt_is_not_duplicated(self):
        state = ccswap.SessionRuntimeState(
            run_id="run-1",
            session_id="550e8400-e29b-41d4-a716-446655440000",
            last_prompt="explain this",
        )
        self.assertEqual(
            ccswap._build_resume_args(["--model", "sonnet", "explain this"], state, False),
            ["--resume", "550e8400-e29b-41d4-a716-446655440000", "--model", "sonnet", "explain this"],
        )

    def test_continue_mode_does_not_replay_prompt(self):
        state = ccswap.SessionRuntimeState(
            run_id="run-1",
            session_id="550e8400-e29b-41d4-a716-446655440000",
            last_prompt="last message",
            replay_mode="continue",
        )
        self.assertEqual(
            ccswap._build_resume_args(["--model", "sonnet", "initial prompt"], state, False),
            ["--resume", "550e8400-e29b-41d4-a716-446655440000", "--model", "sonnet"],
        )

    def test_custom_prompt_mode_uses_configured_prompt(self):
        state = ccswap.SessionRuntimeState(
            run_id="run-1",
            session_id="550e8400-e29b-41d4-a716-446655440000",
            replay_mode="custom_prompt",
            custom_prompt="resume and summarize first",
        )
        self.assertEqual(
            ccswap._build_resume_args(["--model", "sonnet"], state, False),
            ["--resume", "550e8400-e29b-41d4-a716-446655440000", "--model", "sonnet", "resume and summarize first"],
        )


class NormalizeCliArgsTests(unittest.TestCase):
    def test_dashboard_when_no_args(self):
        self.assertEqual(ccswap.normalize_cli_args([]), [])

    def test_non_proxy_commands_unchanged(self):
        self.assertEqual(ccswap.normalize_cli_args(["account", "list"]), ["account", "list"])

    def test_claude_proxy_without_args_maps_to_run(self):
        self.assertEqual(ccswap.normalize_cli_args(["claude"]), ["run"])

    def test_claude_proxy_with_args_routes_through_run(self):
        self.assertEqual(
            ccswap.normalize_cli_args(["claude", "--model", "haiku", "-p", "hi"]),
            ["run", "--", "--model", "haiku", "-p", "hi"],
        )


class AccountNormalizationTests(unittest.TestCase):
    def test_keychain_fields_are_filled(self):
        config = ccswap.AppConfig(
            accounts=[ccswap.Account(name="work", claude_config_dir="/tmp/work")],
            claude_bin="claude",
        )
        config.normalize_accounts()
        account = config.accounts[0]
        self.assertTrue(account.keychain_service.startswith("ccswap-account:"))
        self.assertTrue(account.keychain_account)


class LimitDetectorTests(unittest.TestCase):
    def test_detects_limit_phrase(self):
        detector = ccswap.LimitDetector()
        detector.feed(b"You've hit your limit \xe2\x80\xa2 resets 10pm (Asia/Seoul)")
        self.assertTrue(detector.matched)


class PickAccountTests(unittest.TestCase):
    def test_skips_accounts_excluded_from_auto_swap(self):
        accounts = [
            ccswap.Account(name="work", claude_config_dir="/tmp/work", auto_swap=False),
            ccswap.Account(name="personal", claude_config_dir="/tmp/personal"),
        ]
        state = ccswap.AppState(active_account=None, last_account=None)
        picked = ccswap._pick_account_name(accounts, state, exclude=set())
        self.assertEqual(picked, "personal")

    def test_respects_rotation_after_last_account(self):
        accounts = [
            ccswap.Account(name="work", claude_config_dir="/tmp/work"),
            ccswap.Account(name="personal", claude_config_dir="/tmp/personal"),
            ccswap.Account(name="backup", claude_config_dir="/tmp/backup"),
        ]
        state = ccswap.AppState(active_account=None, last_account="personal")
        picked = ccswap._pick_account_name(accounts, state, exclude=set())
        self.assertEqual(picked, "backup")

    def test_prepare_account_auth_prefers_keychain(self):
        account = ccswap.Account(name="work", claude_config_dir="/tmp/work")
        original_activate = ccswap.activate_account_credentials
        try:
            ccswap.activate_account_credentials = lambda _account: True
            ok, mode, config_dir = ccswap.prepare_account_auth(account)
            self.assertTrue(ok)
            self.assertEqual(mode, "keychain")
            self.assertIsNone(config_dir)
        finally:
            ccswap.activate_account_credentials = original_activate


class RenameAccountTests(unittest.TestCase):
    def test_rename_updates_state_references(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            old_config_dir = ccswap.CONFIG_DIR
            old_config_path = ccswap.CONFIG_PATH
            old_state_path = ccswap.STATE_PATH
            old_accounts_dir = ccswap.ACCOUNTS_DIR
            try:
                ccswap.CONFIG_DIR = tmp
                ccswap.CONFIG_PATH = tmp / "config.json"
                ccswap.STATE_PATH = tmp / "state.json"
                ccswap.ACCOUNTS_DIR = tmp / "accounts"

                config = ccswap.AppConfig(
                    accounts=[ccswap.Account(name="old", claude_config_dir="/tmp/old")],
                    claude_bin="claude",
                )
                state = ccswap.AppState(
                    active_account="old",
                    last_account="old",
                )
                ccswap.rename_account(config, state, "old", "new")
                self.assertEqual(config.accounts[0].name, "new")
                self.assertEqual(state.active_account, "new")
                self.assertEqual(state.last_account, "new")
            finally:
                ccswap.CONFIG_DIR = old_config_dir
                ccswap.CONFIG_PATH = old_config_path
                ccswap.STATE_PATH = old_state_path
                ccswap.ACCOUNTS_DIR = old_accounts_dir


class ClaudeEnvTests(unittest.TestCase):
    def test_claude_env_clears_legacy_auth_env(self):
        env = ccswap._claude_env("/tmp/account")
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], "/tmp/account")
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", env)


class RuntimeStateTests(unittest.TestCase):
    def test_runtime_state_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "runtime.json"
            saved = ccswap.update_runtime_state(
                path,
                "run-1",
                session_id="sid-1",
                last_prompt="continue",
                cwd="/tmp/project",
                active_account="work",
            )
            self.assertEqual(saved.session_id, "sid-1")
            loaded = ccswap.SessionRuntimeState.load(path, "run-1")
            self.assertEqual(loaded.last_prompt, "continue")
            self.assertEqual(loaded.cwd, "/tmp/project")
            self.assertEqual(loaded.active_account, "work")
            self.assertEqual(loaded.replay_mode, "last_prompt")

    def test_inject_runtime_settings_adds_hooks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            old_runtime_dir = ccswap.RUNTIME_DIR
            try:
                ccswap.RUNTIME_DIR = Path(tmpdir)
                args, settings_path = ccswap.inject_runtime_settings(["--model", "sonnet"], "run-1", Path(tmpdir) / "state.json")
                self.assertIn("--settings", args)
                data = ccswap._load_json(settings_path, {})
                self.assertIn("hooks", data)
                self.assertIn("SessionStart", data["hooks"])
                self.assertIn("UserPromptSubmit", data["hooks"])
            finally:
                ccswap.RUNTIME_DIR = old_runtime_dir

    def test_cleanup_stale_runtime_sessions_removes_dead_pid_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            old_runtime_dir = ccswap.RUNTIME_DIR
            old_process_is_alive = ccswap.process_is_alive
            try:
                ccswap.RUNTIME_DIR = Path(tmpdir)
                run_id = "run-dead"
                state_path = ccswap.runtime_state_path(run_id)
                settings_path = ccswap.runtime_settings_path(run_id)
                ccswap.update_runtime_state(state_path, run_id, claude_pid=424242)
                settings_path.write_text("{}", encoding="utf-8")
                ccswap.process_is_alive = lambda pid: False

                ccswap.cleanup_stale_runtime_sessions()

                self.assertFalse(state_path.exists())
                self.assertFalse(settings_path.exists())
            finally:
                ccswap.RUNTIME_DIR = old_runtime_dir
                ccswap.process_is_alive = old_process_is_alive


class RuntimeCleanupTests(unittest.TestCase):
    def test_cleanup_stale_runtime_sessions_keeps_live_pid_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            old_runtime_dir = ccswap.RUNTIME_DIR
            old_process_is_alive = ccswap.process_is_alive
            try:
                ccswap.RUNTIME_DIR = Path(tmpdir)
                run_id = "run-live"
                state_path = ccswap.runtime_state_path(run_id)
                settings_path = ccswap.runtime_settings_path(run_id)
                ccswap.update_runtime_state(state_path, run_id, claude_pid=1234)
                settings_path.write_text("{}", encoding="utf-8")
                ccswap.process_is_alive = lambda pid: True

                ccswap.cleanup_stale_runtime_sessions()

                self.assertTrue(state_path.exists())
                self.assertTrue(settings_path.exists())
            finally:
                ccswap.RUNTIME_DIR = old_runtime_dir
                ccswap.process_is_alive = old_process_is_alive


class UsageCacheTests(unittest.TestCase):
    def test_parse_usage_cache_prefers_last_good_data_when_rate_limited(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / ".usage-cache.json"
            path.write_text(
                """
{
  "data": {"apiError": "rate-limited", "fiveHour": null, "sevenDay": null},
  "lastGoodData": {"planName": "Team", "fiveHour": 14, "sevenDay": 68, "fiveHourResetAt": "2026-04-20T03:00:00+09:00"},
  "timestamp": 1774166232769
}
""".strip()
                + "\n",
                encoding="utf-8",
            )
            usage = ccswap.parse_usage_cache(path)
            self.assertEqual(usage.plan_name, "Team")
            self.assertEqual(usage.five_hour_pct, 14)
            self.assertEqual(usage.seven_day_pct, 68)
            self.assertEqual(usage.cache_timestamp_ms, 1774166232769)


class PromptSplitTests(unittest.TestCase):
    def test_split_prompt_from_args(self):
        args, prompt = ccswap._split_prompt_from_args(["--model", "sonnet", "fix this"])
        self.assertEqual(args, ["--model", "sonnet"])
        self.assertEqual(prompt, "fix this")

    def test_split_prompt_preserves_option_values(self):
        args, prompt = ccswap._split_prompt_from_args(["--name", "work", "--model", "sonnet"])
        self.assertEqual(args, ["--name", "work", "--model", "sonnet"])
        self.assertIsNone(prompt)


if __name__ == "__main__":
    unittest.main()
