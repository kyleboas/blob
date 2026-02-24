from types import SimpleNamespace
from unittest.mock import Mock, call, patch

import pytest

import config
from llm_client import AnthropicClient, LLMResponse, LLMUsage, build_gateway_url, get_model_for_tier


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


def test_build_gateway_url() -> None:
    url = build_gateway_url("my-account", "my-gateway", "anthropic")
    assert url == "https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/anthropic"


def test_build_gateway_url_non_anthropic_provider() -> None:
    url = build_gateway_url("acct123", "gw456", "openai")
    assert url == "https://gateway.ai.cloudflare.com/v1/acct123/gw456/openai"


@patch("llm_client.config.CLOUDFLARE_ACCOUNT_ID", "my-account")
@patch("llm_client.config.CLOUDFLARE_AI_GATEWAY_ID", "my-gateway")
@patch("llm_client.config.CLOUDFLARE_AI_PROVIDER", "anthropic")
@patch("llm_client.anthropic.Anthropic")
def test_anthropic_client_uses_gateway_base_url_when_configured(mock_anthropic: Mock) -> None:
    mock_anthropic.return_value = Mock()
    AnthropicClient(api_key="test-key")
    mock_anthropic.assert_called_once_with(
        api_key="test-key",
        base_url="https://gateway.ai.cloudflare.com/v1/my-account/my-gateway/anthropic",
    )


@patch("llm_client.config.CLOUDFLARE_ACCOUNT_ID", "")
@patch("llm_client.config.CLOUDFLARE_AI_GATEWAY_ID", "")
@patch("llm_client.anthropic.Anthropic")
def test_anthropic_client_uses_direct_url_when_gateway_not_configured(mock_anthropic: Mock) -> None:
    mock_anthropic.return_value = Mock()
    AnthropicClient(api_key="test-key")
    mock_anthropic.assert_called_once_with(api_key="test-key")


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


@patch("llm_client.time.sleep")
@patch("llm_client.anthropic.Anthropic")
def test_anthropic_client_retries_on_529(mock_anthropic: Mock, mock_sleep: Mock) -> None:
    overload_exc = Exception("overloaded")
    overload_exc.status_code = 529  # type: ignore[attr-defined]

    success_response = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="hello")],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=5, output_tokens=3),
    )

    mocked_api = Mock()
    mocked_api.messages.create.side_effect = [overload_exc, overload_exc, success_response]
    mock_anthropic.return_value = mocked_api

    client = AnthropicClient(api_key="test-key")
    result = client.create_message(
        model="claude-haiku-4-5",
        system="sys",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert result.stop_reason == "end_turn"
    assert mocked_api.messages.create.call_count == 3
    assert mock_sleep.call_count == 2
    assert mock_sleep.call_args_list == [call(5.0), call(10.0)]


@patch("llm_client.time.sleep")
@patch("llm_client.anthropic.Anthropic")
def test_anthropic_client_raises_after_exhausting_529_retries(mock_anthropic: Mock, mock_sleep: Mock) -> None:
    overload_exc = Exception("overloaded")
    overload_exc.status_code = 529  # type: ignore[attr-defined]

    mocked_api = Mock()
    mocked_api.messages.create.side_effect = overload_exc
    mock_anthropic.return_value = mocked_api

    client = AnthropicClient(api_key="test-key")
    with pytest.raises(Exception, match="overloaded"):
        client.create_message(
            model="claude-haiku-4-5",
            system="sys",
            messages=[{"role": "user", "content": "hi"}],
        )

    assert mocked_api.messages.create.call_count == config.LLM_OVERLOAD_RETRY_MAX + 1
    assert mock_sleep.call_count == config.LLM_OVERLOAD_RETRY_MAX


@patch("llm_client.time.sleep")
@patch("llm_client.anthropic.Anthropic")
def test_anthropic_client_retries_on_429(mock_anthropic: Mock, mock_sleep: Mock) -> None:
    rate_limit_exc = Exception("rate limited")
    rate_limit_exc.status_code = 429  # type: ignore[attr-defined]

    success_response = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="hello")],
        stop_reason="end_turn",
        usage=SimpleNamespace(input_tokens=5, output_tokens=3),
    )

    mocked_api = Mock()
    mocked_api.messages.create.side_effect = [rate_limit_exc, success_response]
    mock_anthropic.return_value = mocked_api

    client = AnthropicClient(api_key="test-key")
    result = client.create_message(
        model="claude-haiku-4-5",
        system="sys",
        messages=[{"role": "user", "content": "hi"}],
    )

    assert result.stop_reason == "end_turn"
    assert mocked_api.messages.create.call_count == 2
    mock_sleep.assert_called_once_with(5.0)


@patch("llm_client.time.sleep")
@patch("llm_client.anthropic.Anthropic")
def test_anthropic_client_does_not_retry_non_retriable_errors(mock_anthropic: Mock, mock_sleep: Mock) -> None:
    generic_exc = Exception("bad request")
    generic_exc.status_code = 400  # type: ignore[attr-defined]

    mocked_api = Mock()
    mocked_api.messages.create.side_effect = generic_exc
    mock_anthropic.return_value = mocked_api

    client = AnthropicClient(api_key="test-key")
    with pytest.raises(Exception, match="bad request"):
        client.create_message(
            model="claude-haiku-4-5",
            system="sys",
            messages=[{"role": "user", "content": "hi"}],
        )

    assert mocked_api.messages.create.call_count == 1
    mock_sleep.assert_not_called()
