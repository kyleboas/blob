from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

import config
from llm_client import AnthropicClient, LLMResponse, LLMUsage, get_model_for_tier


def test_llm_response_dataclass_construction() -> None:
    response = LLMResponse(
        content=[{"type": "text", "text": "done"}],
        stop_reason="end_turn",
        usage=LLMUsage(input_tokens=10, output_tokens=2),
    )

    assert response.content[0]["text"] == "done"
    assert response.stop_reason == "end_turn"
    assert response.usage.input_tokens == 10


def test_get_model_for_tier_uses_config_mapping() -> None:
    assert get_model_for_tier("routine") == config.MODEL_ROUTING["routine"]
    assert get_model_for_tier("complex") == config.MODEL_ROUTING["complex"]


def test_get_model_for_tier_raises_for_unknown_tier() -> None:
    with pytest.raises(ValueError):
        get_model_for_tier("unknown")


@patch("llm_client.anthropic.Anthropic")
def test_anthropic_client_maps_response(mock_anthropic: Mock) -> None:
    mocked_api = Mock()
    mocked_api.messages.create.return_value = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="hello")],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=11, output_tokens=7),
    )
    mock_anthropic.return_value = mocked_api

    client = AnthropicClient(api_key="test-key")
    result = client.create_message(
        model="claude-haiku-4-5",
        system="sys",
        messages=[{"role": "user", "content": "hi"}],
        tools=[{"name": "bash", "input_schema": {"type": "object"}}],
    )

    assert result.stop_reason == "end_turn"
    assert result.usage.input_tokens == 11
    assert result.content == [{"type": "text", "text": "hello"}]

    kwargs = mocked_api.messages.create.call_args.kwargs
    assert kwargs["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kwargs["tools"][0]["cache_control"] == {"type": "ephemeral"}
