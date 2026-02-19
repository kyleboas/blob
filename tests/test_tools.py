from tools import BASH_TOOL, format_tool_result


def test_bash_tool_schema() -> None:
    assert BASH_TOOL["name"] == "bash"
    assert BASH_TOOL["input_schema"]["required"] == ["command"]


def test_format_tool_result() -> None:
    payload = format_tool_result("abc", "done")
    assert payload["type"] == "tool_result"
    assert payload["tool_use_id"] == "abc"
    assert payload["content"][0]["text"] == "done"
