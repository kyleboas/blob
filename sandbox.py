"""Sandboxed command execution with basic policy checks."""

from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatch
import re
import subprocess
from typing import Protocol

import config

SUSPICIOUS_PATTERNS = [
    re.compile(r"\b169\.254\.169\.254\b"),
    re.compile(r"/etc/resolv\.conf"),
    re.compile(r"\bcurl\b.+https?://(?!api\.anthropic\.com|docs\.anthropic\.com)", re.IGNORECASE),
    re.compile(r"\bwget\b.+https?://(?!api\.anthropic\.com|docs\.anthropic\.com)", re.IGNORECASE),
]


@dataclass(slots=True)
class ExecutionResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False


class SandboxExecutor(Protocol):
    def execute(self, command: str, timeout: int) -> ExecutionResult:
        """Execute a command in a sandbox."""


def is_command_safe(command: str) -> bool:
    return not any(pattern.search(command) for pattern in SUSPICIOUS_PATTERNS)


def truncate_output(text: str, max_length: int = 10_000) -> str:
    if len(text) <= max_length:
        return text
    suffix = f"\n...[truncated {len(text) - max_length} chars]"
    return text[:max_length] + suffix


class FlySpriteSandbox:
    """Sprite-like sandbox interface with local subprocess fallback implementation."""

    def __init__(
        self,
        memory_limit_mb: int = config.MEMORY_LIMIT_MB,
        allowlist: list[str] | None = None,
        max_output_chars: int = 10_000,
    ) -> None:
        self.memory_limit_mb = memory_limit_mb
        self.allowlist = allowlist or config.NETWORK_ALLOWLIST
        self.max_output_chars = max_output_chars

    def build_network_policy(self) -> dict[str, object]:
        return {
            "default_action": "deny",
            "allow": [{"host": host} for host in self.allowlist],
        }

    def allows_host(self, host: str) -> bool:
        return any(fnmatch(host, pattern) for pattern in self.allowlist)

    def execute(self, command: str, timeout: int = config.COMMAND_TIMEOUT) -> ExecutionResult:
        if not is_command_safe(command):
            return ExecutionResult(
                stdout="",
                stderr="Command rejected by sandbox policy",
                exit_code=1,
                timed_out=False,
            )

        try:
            completed = subprocess.run(
                command,
                shell=True,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return ExecutionResult(
                stdout=truncate_output(completed.stdout, self.max_output_chars),
                stderr=truncate_output(completed.stderr, self.max_output_chars),
                exit_code=completed.returncode,
                timed_out=False,
            )
        except subprocess.TimeoutExpired as exc:
            return ExecutionResult(
                stdout=truncate_output(exc.stdout or "", self.max_output_chars),
                stderr=truncate_output(exc.stderr or "", self.max_output_chars),
                exit_code=124,
                timed_out=True,
            )
