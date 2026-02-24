import os
from pathlib import Path
from unittest.mock import patch

from sandbox import ExecutionResult, FlySpriteSandbox, _GIT_ASKPASS, is_command_safe, truncate_output


def test_execution_result_construction() -> None:
    result = ExecutionResult(stdout="ok", stderr="", exit_code=0, timed_out=False)
    assert result.stdout == "ok"
    assert result.exit_code == 0


def test_command_injection_detection_patterns() -> None:
    assert not is_command_safe("curl https://evil.com")
    assert not is_command_safe("cat /etc/resolv.conf")
    assert is_command_safe("curl https://docs.anthropic.com")
    assert is_command_safe("curl https://github.com")
    assert is_command_safe("curl https://api.github.com/repos/owner/repo/pulls")


def test_output_truncation() -> None:
    text = "a" * 30
    truncated = truncate_output(text, max_length=10)
    assert truncated.startswith("a" * 10)
    assert "truncated" in truncated


def test_timeout_handling_logic() -> None:
    sandbox = FlySpriteSandbox(max_output_chars=1000)
    result = sandbox.execute("python -c 'import time; time.sleep(0.2)'", timeout=0)
    assert result.timed_out is True
    assert result.exit_code == 124


def test_build_subprocess_env_sets_git_terminal_prompt() -> None:
    sandbox = FlySpriteSandbox()
    env = sandbox._build_subprocess_env()
    assert env.get("GIT_TERMINAL_PROMPT") == "0"


def test_build_subprocess_env_sets_git_askpass_when_script_executable() -> None:
    sandbox = FlySpriteSandbox()
    # The script ships in the repo and should be executable.
    if _GIT_ASKPASS.exists() and os.access(_GIT_ASKPASS, os.X_OK):
        env = sandbox._build_subprocess_env()
        assert env.get("GIT_ASKPASS") == str(_GIT_ASKPASS)


def test_build_subprocess_env_skips_git_askpass_when_script_missing() -> None:
    sandbox = FlySpriteSandbox()
    with patch("sandbox._GIT_ASKPASS", Path("/nonexistent/git-askpass.py")):
        env = sandbox._build_subprocess_env()
        assert "GIT_ASKPASS" not in env
        assert env.get("GIT_TERMINAL_PROMPT") == "0"


def test_execute_passes_git_auth_env_to_subprocess() -> None:
    """Commands run via the sandbox inherit GIT_TERMINAL_PROMPT=0."""
    sandbox = FlySpriteSandbox()
    result = sandbox.execute("echo $GIT_TERMINAL_PROMPT", timeout=10)
    assert result.exit_code == 0
    assert "0" in result.stdout


def test_git_askpass_script_returns_token_for_password_prompt() -> None:
    """The askpass helper outputs the token when git asks for a password."""
    if not _GIT_ASKPASS.exists():
        return
    import subprocess
    env = {**os.environ, "GITHUB_TOKEN": "test-token-123"}
    result = subprocess.run(
        ["python3", str(_GIT_ASKPASS), "Password for 'https://github.com': "],
        capture_output=True,
        text=True,
        env=env,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "test-token-123"


def test_git_askpass_script_returns_username_for_username_prompt() -> None:
    """The askpass helper outputs x-access-token when git asks for a username."""
    if not _GIT_ASKPASS.exists():
        return
    import subprocess
    result = subprocess.run(
        ["python3", str(_GIT_ASKPASS), "Username for 'https://github.com': "],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "x-access-token"
