"""Sandboxed command execution with policy checks and resource limits."""

from __future__ import annotations

from dataclasses import dataclass
from fnmatch import fnmatch
import ipaddress
import re
import resource
import subprocess
from typing import Protocol
from urllib.parse import urlparse

import config

URL_PATTERN = re.compile(r"https?://[^\s'\"]+")
PRIVATE_HOST_PATTERNS = {
    "localhost",
    "127.0.0.1",
    "::1",
    "169.254.169.254",
}


@dataclass(slots=True)
class ExecutionResult:
    stdout: str
    stderr: str
    exit_code: int
    timed_out: bool = False


class SandboxExecutor(Protocol):
    def execute(self, command: str, timeout: int) -> ExecutionResult:
        """Execute a command in a sandbox."""


def _host_is_private(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized in PRIVATE_HOST_PATTERNS:
        return True
    try:
        ip = ipaddress.ip_address(normalized)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def _extract_hosts_from_command(command: str) -> set[str]:
    hosts: set[str] = set()
    for match in URL_PATTERN.findall(command):
        parsed = urlparse(match)
        if parsed.hostname:
            hosts.add(parsed.hostname)
    return hosts


def is_command_safe(command: str, allowlist: list[str] | None = None) -> bool:
    hosts = _extract_hosts_from_command(command)
    policy = allowlist or config.NETWORK_ALLOWLIST

    for host in hosts:
        if _host_is_private(host):
            return False
        if not any(fnmatch(host, pattern) for pattern in policy):
            return False

    lowered = command.lower()
    if "/etc/resolv.conf" in lowered:
        return False
    return True


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
            "block_private_ranges": True,
            "block_localhost": True,
            "block_metadata": True,
        }

    def allows_host(self, host: str) -> bool:
        return any(fnmatch(host, pattern) for pattern in self.allowlist)

    def execute(self, command: str, timeout: int = config.COMMAND_TIMEOUT) -> ExecutionResult:
        if not is_command_safe(command, self.allowlist):
            return ExecutionResult(
                stdout="",
                stderr="Command rejected by sandbox policy",
                exit_code=1,
                timed_out=False,
            )

        def _apply_limits() -> None:
            memory_bytes = self.memory_limit_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))

        try:
            completed = subprocess.run(
                command,
                shell=True,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout,
                preexec_fn=_apply_limits,
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
