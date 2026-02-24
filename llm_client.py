"""LLM provider abstraction with Anthropic and OpenAI routing."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
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
    """Return the Cloudflare AI Gateway base URL for the given provider.

    For the Anthropic SDK this is the base URL (SDK appends /v1/messages).
    For direct HTTP calls use _gateway_endpoint_url() instead.
    """
    return f"https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}"


def _gateway_endpoint_url(account_id: str, gateway_id: str, provider: str) -> str:
    """Return the full gateway URL including the provider-specific endpoint path."""
    endpoint = "/v1/chat/completions" if provider == "openai" else "/v1/messages"
    return f"https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/{provider}{endpoint}"


def _parse_model(model: str) -> tuple[str, str]:
    """Split 'provider/model-name' into (provider, model_name).

    Models without a '/' prefix are assumed to be Anthropic.
    """
    if "/" in model:
        provider, model_name = model.split("/", 1)
        return provider, model_name
    return "anthropic", model


# ─── Anthropic → OpenAI format adapters ──────────────────────────────────────

def _convert_messages_to_openai(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert an Anthropic-format message list to OpenAI chat format."""
    result: list[dict[str, Any]] = []
    for msg in messages:
        role = msg["role"]
        content = msg["content"]
        if role == "user":
            if isinstance(content, str):
                result.append({"role": "user", "content": content})
            elif isinstance(content, list):
                for block in content:
                    if block.get("type") == "tool_result":
                        raw = block.get("content", "")
                        if isinstance(raw, list):
                            text = "\n".join(
                                c.get("text", "") for c in raw if c.get("type") == "text"
                            )
                        else:
                            text = str(raw)
                        result.append({
                            "role": "tool",
                            "tool_call_id": block["tool_use_id"],
                            "content": text,
                        })
                    elif block.get("type") == "text":
                        result.append({"role": "user", "content": block["text"]})
        elif role == "assistant":
            if isinstance(content, str):
                result.append({"role": "assistant", "content": content})
            elif isinstance(content, list):
                text_parts = [b["text"] for b in content if b.get("type") == "text"]
                tool_uses = [b for b in content if b.get("type") == "tool_use"]
                assistant_msg: dict[str, Any] = {
                    "role": "assistant",
                    "content": "\n".join(text_parts) if text_parts else None,
                }
                if tool_uses:
                    assistant_msg["tool_calls"] = [
                        {
                            "id": b["id"],
                            "type": "function",
                            "function": {
                                "name": b["name"],
                                "arguments": json.dumps(b.get("input", {})),
                            },
                        }
                        for b in tool_uses
                    ]
                result.append(assistant_msg)
    return result


def _convert_tools_to_openai(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert Anthropic tool schemas to OpenAI function schemas."""
    result = []
    for tool in tools:
        result.append({
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {}),
            },
        })
    return result


def _parse_openai_response(data: dict[str, Any]) -> LLMResponse:
    """Convert an OpenAI chat completion response to the internal LLMResponse format."""
    choice = data["choices"][0]
    message = choice["message"]
    finish_reason = choice.get("finish_reason", "stop")

    content: list[dict[str, Any]] = []
    if message.get("content"):
        content.append({"type": "text", "text": message["content"]})
    for tool_call in message.get("tool_calls") or []:
        try:
            input_data = json.loads(tool_call["function"]["arguments"])
        except (json.JSONDecodeError, KeyError):
            input_data = {}
        content.append({
            "type": "tool_use",
            "id": tool_call["id"],
            "name": tool_call["function"]["name"],
            "input": input_data,
        })

    stop_reason = "tool_use" if finish_reason == "tool_calls" else "end_turn"
    usage_raw = data.get("usage", {})
    return LLMResponse(
        content=content,
        stop_reason=stop_reason,
        usage=LLMUsage(
            input_tokens=usage_raw.get("prompt_tokens", 0),
            output_tokens=usage_raw.get("completion_tokens", 0),
        ),
    )


def _call_openai_http(
    model: str,
    system: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    api_key: str,
) -> LLMResponse:
    """Call the OpenAI chat completions API (or its gateway proxy) via raw HTTP."""
    oai_messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    oai_messages.extend(_convert_messages_to_openai(messages))

    payload: dict[str, Any] = {
        "model": model,
        "messages": oai_messages,
        "max_tokens": 1024,
    }
    if tools:
        payload["tools"] = _convert_tools_to_openai(tools)

    account_id = config.CLOUDFLARE_ACCOUNT_ID
    gateway_id = config.CLOUDFLARE_AI_GATEWAY_ID
    if account_id and gateway_id:
        url = _gateway_endpoint_url(account_id, gateway_id, "openai")
    else:
        url = "https://api.openai.com/v1/chat/completions"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    retriable_codes = {429, 503, 529}
    last_exc: Exception | None = None
    for attempt in range(config.LLM_OVERLOAD_RETRY_MAX + 1):
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode(),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req) as resp:
                data = json.loads(resp.read())
            return _parse_openai_response(data)
        except urllib.error.HTTPError as exc:
            last_exc = exc
            if exc.code in retriable_codes and attempt < config.LLM_OVERLOAD_RETRY_MAX:
                time.sleep(config.LLM_OVERLOAD_RETRY_BASE_S * (2**attempt))
                continue
            raise
    raise last_exc or RuntimeError("OpenAI API: max retries exceeded")


# ─── AnthropicClient (now routes to OpenAI or Anthropic based on model prefix) ─

class AnthropicClient:
    """LLM client that routes to Anthropic or OpenAI based on the model prefix.

    Models prefixed with "openai/" are sent to the OpenAI API (via gateway if
    configured). All other models use the Anthropic SDK (via gateway if configured).
    """

    def __init__(
        self,
        api_key: str | None = None,
        openai_api_key: str | None = None,
    ) -> None:
        if anthropic.Anthropic is None:
            raise RuntimeError("anthropic package is required to use AnthropicClient")
        self._openai_key: str = openai_api_key or config.OPENAI_API_KEY or ""
        kwargs: dict[str, Any] = {"api_key": api_key}
        account_id = config.CLOUDFLARE_ACCOUNT_ID
        gateway_id = config.CLOUDFLARE_AI_GATEWAY_ID
        if account_id and gateway_id:
            kwargs["base_url"] = build_gateway_url(account_id, gateway_id, "anthropic")
        self._client = anthropic.Anthropic(**kwargs)

    def create_message(
        self,
        model: str,
        system: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> LLMResponse:
        provider, model_name = _parse_model(model)
        if provider == "openai":
            return _call_openai_http(
                model=model_name,
                system=system,
                messages=messages,
                tools=tools,
                api_key=self._openai_key,
            )
        return self._call_anthropic(model_name, system, messages, tools)

    def _call_anthropic(
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
                {**tool, "cache_control": {"type": "ephemeral"}}
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
                    wait = config.LLM_OVERLOAD_RETRY_BASE_S * (2**attempt)
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
