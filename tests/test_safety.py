from datetime import date
from pathlib import Path
from unittest.mock import patch

import safety
from safety import ModificationRateLimiter, is_constitution_file


def test_constitution_file_detection() -> None:
    assert is_constitution_file("safety.py") is True
    assert is_constitution_file("notes.md") is False


def test_git_operations_invoke_git() -> None:
    with patch("safety._run_git") as run_git:
        safety.git_auto_commit("msg")
        safety.git_checkpoint("tag1")
        safety.git_revert_to_checkpoint("tag1")

    assert run_git.call_count >= 3


def test_rate_limiter_counting_and_rejection(tmp_path: Path) -> None:
    count_file = tmp_path / ".modify_count"
    limiter = ModificationRateLimiter(session_count=0, count_file=count_file)

    with patch("config.SELF_MODIFY_LIMIT_SESSION", 1), patch("config.SELF_MODIFY_LIMIT_DAY", 2):
        assert limiter.can_modify() is True
        limiter.record_modification()
        assert limiter.can_modify() is False


def test_rate_limiter_daily_limit(tmp_path: Path) -> None:
    count_file = tmp_path / ".modify_count"
    count_file.write_text(f"{date.today().isoformat()}:10")
    limiter = ModificationRateLimiter(count_file=count_file)
    with patch("config.SELF_MODIFY_LIMIT_DAY", 10):
        assert limiter.can_modify() is False


def test_git_history_returns_output() -> None:
    with patch("safety._run_git") as run_git:
        run_git.return_value.stdout = "abc\n"
        assert safety.git_history() == "abc"
