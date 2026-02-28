from tools import READ_TOOL, WRITE_TOOL, EDIT_TOOL, BASH_TOOL, format_tool_result


def test_read_tool_schema() -> None:
    assert READ_TOOL["name"] == "read"
    assert READ_TOOL["input_schema"]["required"] == ["path"]


def test_write_tool_schema() -> None:
    assert WRITE_TOOL["name"] == "write"
    assert WRITE_TOOL["input_schema"]["required"] == ["path", "content"]


def test_edit_tool_schema() -> None:
    assert EDIT_TOOL["name"] == "edit"
    assert EDIT_TOOL["input_schema"]["required"] == ["path", "old_text", "new_text"]


def test_bash_tool_schema() -> None:
    assert BASH_TOOL["name"] == "bash"
    assert BASH_TOOL["input_schema"]["required"] == ["command"]


def test_format_tool_result() -> None:
    payload = format_tool_result("abc", "done")
    assert payload["type"] == "tool_result"
    assert payload["tool_use_id"] == "abc"
    assert payload["content"][0]["text"] == "done"
