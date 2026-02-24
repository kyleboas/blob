"""LLM provider abstraction and Anthropic implementation."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol

try:
    import anthropic
except ImportError:  # pragma: no cover - dependency may be unavailable in tests
    from types import SimpleNamespace

    anthropic = SimpleNamespace(Anthropic=None)

import config


@dataclass(slots=True)
class LLMUsage:
    input_tokens: int
    output_tokens: int


@dataclass(slots=True)
class LLMResponse:
    content: list[dict[str, Any]]
    stop_reason: str | None
    usage: LLMUsage


class LLMClient(Protocol):
    def create_message(
        self,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse:
        """Create a standardized message response."""


def get_model_for_tier(tier: str) -> str:
    """Map a task tier to a configured model."""
    try:
        return config.MODEL_ROUTING[tier]
    except KeyError as exc:
        raise ValueError(f"Unknown tier: {tier}") from exc


def build_gateway_url(account_id: str, gateway_id: str, provider: str) -> str:
    """Return the Cloudflare AI Gateway base URL for the given provider."""
    return f"https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}"


class AnthropicClient:
    """Anthropic-backed client implementing LLMClient protocol."""

    def __init__(self, api_key: str | None = None) -> None:
        if anthropic.Anthropic is None:
            raise RuntimeError("anthropic package is required to use AnthropicClient")
        kwargs: dict[str, Any] = {"api_key": api_key}
        account_id = config.CLOUDFLARE_ACCOUNT_ID
        gateway_id = config.CLOUDFLARE_AI_GATEWAY_ID
        provider = config.CLOUDFLARE_AI_PROVIDER
        if account_id and gateway_id:
            kwargs["base_url"] = build_gateway_url(account_id, gateway_id, provider)
        self._client = anthropic.Anthropic(**kwargs)

    def create_message(
        self,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse:
        payload: dict[str, Any] = {
            "model": model,
            "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
            "max_tokens": 1024,
        }
        if tools:
            payload["tools"] = [
                {
                    **tool,
                    "cache_control": {"type": "ephemeral"},
                }
                for tool in tools
            ]

        response = None
        retriable_status_codes = {429, 529}
        for attempt in range(config.LLM_OVERLOAD_RETRY_MAX + 1):
            try:
                response = self._client.messages.create(**payload)
                break
            except Exception as exc:
                status_code = getattr(exc, "status_code", None)
                if status_code in retriable_status_codes and attempt < config.LLM_OVERLOAD_RETRY_MAX:
                    wait = config.LLM_OVERLOAD_RETRY_BASE_S * (2 ** attempt)
                    time.sleep(wait)
                    continue
                raise

        usage = LLMUsage(
            input_tokens=getattr(response.usage, "input_tokens", 0),
            output_tokens=getattr(response.usage, "output_tokens", 0),
        )
        normalized_content = [
            {"type": block.type, **({"text": block.text} if hasattr(block, "text") else {})}
            for block in response.content
        ]
        return LLMResponse(
            content=normalized_content,
            stop_reason=getattr(response, "stop_reason", None),
            usage=usage,
        )
