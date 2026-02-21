from tools import BASH_TOOL, MAKE_PR_TOOL, PUSH_BRANCH_TOOL, format_tool_result


def test_bash_tool_schema() -> None:
    assert BASH_TOOL["name"] == "bash"
    assert BASH_TOOL["input_schema"]["required"] == ["command"]


def test_make_pr_tool_schema() -> None:
    assert MAKE_PR_TOOL["name"] == "make_pr"
    assert MAKE_PR_TOOL["input_schema"]["required"] == ["title", "body"]


def test_push_branch_tool_schema() -> None:
    assert PUSH_BRANCH_TOOL["name"] == "push_branch"


def test_format_tool_result() -> None:
    payload = format_tool_result("abc", "done")
    assert payload["type"] == "tool_result"
    assert payload["tool_use_id"] == "abc"
    assert payload["content"][0]["text"] == "done"
