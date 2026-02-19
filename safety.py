"""Git safety helpers, constitution checks, and modification rate limiting."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path
import subprocess

import config


MODIFY_COUNT_FILE = config.WORKSPACE_ROOT / ".modify_count"


def _run_git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=config.WORKSPACE_ROOT, check=True, text=True, capture_output=True)


def git_auto_commit(message: str) -> None:
    _run_git("add", "-A")
    _run_git("commit", "-m", message)


def git_checkpoint(tag: str) -> None:
    _run_git("tag", "-f", tag)


def git_revert_to_checkpoint(tag: str) -> None:
    _run_git("reset", "--hard", tag)


def git_history() -> str:
    result = _run_git("log", "--oneline", "-20")
    return result.stdout.strip()


def is_constitution_file(path: str) -> bool:
    normalized = str(Path(path))
    return normalized in config.CONSTITUTION_FILES


@dataclass
class ModificationRateLimiter:
    session_count: int = 0
    count_file: Path = MODIFY_COUNT_FILE

    def _read_daily_count(self) -> tuple[date, int]:
        if not self.count_file.exists():
            return date.today(), 0
        raw = self.count_file.read_text().strip()
        if not raw:
            return date.today(), 0
        day_str, count_str = raw.split(":", maxsplit=1)
        return date.fromisoformat(day_str), int(count_str)

    def _write_daily_count(self, count: int) -> None:
        self.count_file.write_text(f"{date.today().isoformat()}:{count}")

    def can_modify(self) -> bool:
        if self.session_count >= config.SELF_MODIFY_LIMIT_SESSION:
            return False
        day, daily_count = self._read_daily_count()
        if day != date.today():
            daily_count = 0
        if daily_count >= config.SELF_MODIFY_LIMIT_DAY:
            return False
        return True

    def record_modification(self) -> None:
        day, daily_count = self._read_daily_count()
        if day != date.today():
            daily_count = 0
        self.session_count += 1
        self._write_daily_count(daily_count + 1)
