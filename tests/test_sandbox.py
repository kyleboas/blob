from sandbox import ExecutionResult, FlySpriteSandbox, is_command_safe, truncate_output


def test_execution_result_construction() -> None:
    result = ExecutionResult(stdout="ok", stderr="", exit_code=0, timed_out=False)
    assert result.stdout == "ok"
    assert result.exit_code == 0


def test_command_injection_detection_patterns() -> None:
    assert not is_command_safe("curl https://evil.com")
    assert not is_command_safe("cat /etc/resolv.conf")
    assert is_command_safe("curl https://docs.anthropic.com")


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
