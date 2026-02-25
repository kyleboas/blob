"""Core ReAct-style agent loop and self-improvement orchestration."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
import shlex
from typing import Callable
from urllib.parse import quote, urlparse

import config
from approval import ApprovalGate, AutonomousApprovalGate, classify_action
from llm_client import LLMClient
from safety import (
    ModificationRateLimiter,
    append_audit_log,
    git_auto_commit,
    git_checkpoint,
    git_history,
    git_revert_to_checkpoint,
    log_activity,
)
from sandbox import SandboxExecutor
from tools import BASH_TOOL, MAKE_PR_TOOL, PUSH_BRANCH_TOOL, format_tool_result


class _HTMLToTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[str] = []

    def handle_data(self, data: str) -> None:
        cleaned = data.strip()
        if cleaned:
            self._chunks.append(cleaned)

    def as_markdown(self) -> str:
        return "\n\n".join(self._chunks)


def _extract_target_files(command: str) -> list[str]:
    files: list[str] = []
    for token in command.replace(">>", " ").replace(">", " ").split():
        if token.endswith(".py") or token.endswith(".md") or token.endswith(".json"):
            files.append(token)
    return files


def _is_modification_command(command: str, target_files: list[str]) -> bool:
    lowered = command.strip().lower()
    if target_files:
        return True
    return bool(re.search(r"(>>|>|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bsed\s+-i)", lowered))


def _extract_urls(text: str) -> list[str]:
    matches = re.findall(r"https?://\S+", text)
    cleaned: list[str] = []
    for match in matches:
        normalized = match.split("|", 1)[0]
        normalized = normalized.lstrip("<")
        normalized = normalized.rstrip(".,!?:;\"')>]}")
        if normalized not in cleaned:
            cleaned.append(normalized)
    return cleaned


def _parse_github_repo(remote_url: str) -> str | None:
    cleaned = remote_url.strip()
    https_match = re.search(r"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?$", cleaned)
    if https_match:
        return https_match.group(1)
    return None


@dataclass(slots=True)
class ImprovementTask:
    id: str
    title: str
    status: str


class Agent:
    def __init__(
        self,
        llm_client: LLMClient,
        sandbox: SandboxExecutor,
        approval_gate: ApprovalGate,
        on_status: Callable[[str], None] | None = None,
        rate_limiter: ModificationRateLimiter | None = None,
    ) -> None:
        self.llm_client = llm_client
        self.sandbox = sandbox
        self.approval_gate = approval_gate
        self.on_status = on_status
        self.rate_limiter = rate_limiter or ModificationRateLimiter()
        self._system_prompt = self._build_system_prompt()
        self._base_messages: list[dict[str, object]] = []

    def _build_system_prompt(self) -> str:
        return "\n".join(
            [
                "You are Blob, a self-modifying coding agent.",
                "Operate on your repository and use git history to answer questions about recent changes.",
                "Use bash tools to inspect files and run tests before finishing code changes.",
                "When asked to remember long-term preferences, save them to AGENT.md.",
            ]
        )

    def _emit_status(self, message: str) -> None:
        log_activity("status", {"message": message})
        if self.on_status:
            self.on_status(message)

    def _select_model_for_task(self, task: str) -> str:
        lowered = task.lower()
        if any(keyword in lowered for keyword in ("refactor", "architecture", "security", "self-modify")):
            return config.MODEL_ROUTING["complex"]
        return config.MODEL_ROUTING["routine"]

    def _record_llm_usage(self, task: str, model: str, input_tokens: int, output_tokens: int) -> None:
        log_activity(
            "llm_usage",
            {
                "task": task[:120],
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
            },
        )
        append_audit_log(
            config.LLM_TELEMETRY_LOG,
            {
                "task": task[:120],
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
            },
        )

    def _get_authenticated_push_url(self, remote: str = "origin") -> str | None:
        """Return a GitHub HTTPS remote URL with the token embedded, or None if unavailable.

        Using a token-embedded URL lets ``git push`` authenticate without an
        interactive credential prompt, which is necessary in non-TTY sandbox
        environments where git cannot read a username/password.
        """
        token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN") or ""
        if not token:
            return None
        get_url = subprocess.run(
            ["git", "remote", "get-url", remote],
            cwd=config.WORKSPACE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if get_url.returncode != 0:
            return None
        repo = _parse_github_repo(get_url.stdout)
        if not repo:
            return None
        return f"https://{token}@github.com/{repo}.git"

    def _push_branch_to_remote(self, tool_input: dict[str, object]) -> str:
        remote = str(tool_input.get("remote", "origin")).strip() or "origin"

        branch = str(tool_input.get("branch", "")).strip()
        if not branch:
            branch_cmd = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=config.WORKSPACE_ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            if branch_cmd.returncode != 0:
                return "error: unable to determine current branch"
            branch = branch_cmd.stdout.strip()

        if branch == "HEAD":
            return "error: detached HEAD is not supported; checkout a branch first"

        push_target = self._get_authenticated_push_url(remote) or remote
        set_upstream = bool(tool_input.get("set_upstream", True))
        push_command = ["git", "push"]
        if set_upstream:
            push_command.append("-u")
        push_command.extend([push_target, branch])

        push = subprocess.run(
            push_command,
            cwd=config.WORKSPACE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if push.returncode != 0:
            return f"error: failed to push branch\n{push.stderr.strip()}"

        return f"ok: pushed {branch} to {remote}"

    def _create_github_pr(self, tool_input: dict[str, object]) -> str:
        token = subprocess.run(
            ["bash", "-lc", "printf %s \"${GITHUB_TOKEN:-${GH_TOKEN:-}}\""],
            cwd=config.WORKSPACE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if not token:
            return "error: missing GITHUB_TOKEN (or GH_TOKEN) in environment"

        title = str(tool_input.get("title", "")).strip()
        body = str(tool_input.get("body", "")).strip()
        if not title:
            return "error: pull request title is required"

        repo = str(tool_input.get("repo", "")).strip()
        if not repo:
            remote = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                cwd=config.WORKSPACE_ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            if remote.returncode != 0:
                return "error: unable to resolve origin remote"
            parsed_repo = _parse_github_repo(remote.stdout)
            if not parsed_repo:
                return "error: origin remote is not a GitHub repository; provide repo as owner/name"
            repo = parsed_repo

        head = str(tool_input.get("head", "")).strip()
        if not head:
            branch_cmd = subprocess.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                cwd=config.WORKSPACE_ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            if branch_cmd.returncode != 0:
                return "error: unable to determine current branch"
            head = branch_cmd.stdout.strip()
        if head == "HEAD":
            return "error: detached HEAD is not supported; checkout a branch first"

        base = str(tool_input.get("base", "")).strip()
        if not base:
            default_base = subprocess.run(
                ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
                cwd=config.WORKSPACE_ROOT,
                check=False,
                capture_output=True,
                text=True,
            )
            if default_base.returncode == 0 and default_base.stdout.strip().startswith("refs/remotes/origin/"):
                base = default_base.stdout.strip().removeprefix("refs/remotes/origin/")
            else:
                base = "main"

        push_target = self._get_authenticated_push_url("origin") or "origin"
        push = subprocess.run(
            ["git", "push", "-u", push_target, head],
            cwd=config.WORKSPACE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if push.returncode != 0:
            return f"error: failed to push branch\n{push.stderr.strip()}"

        payload = {
            "title": title,
            "body": body,
            "head": head,
            "base": base,
            "draft": bool(tool_input.get("draft", False)),
        }

        create_pr = subprocess.run(
            [
                "curl",
                "-fsSL",
                "-X",
                "POST",
                "https://api.github.com/repos/{}/pulls".format(repo),
                "-H",
                "Accept: application/vnd.github+json",
                "-H",
                f"Authorization: Bearer {token}",
                "-H",
                "X-GitHub-Api-Version: 2022-11-28",
                "-d",
                json.dumps(payload),
            ],
            cwd=config.WORKSPACE_ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if create_pr.returncode != 0:
            return f"error: failed to create pull request\n{create_pr.stderr.strip()}"

        try:
            response = json.loads(create_pr.stdout)
        except json.JSONDecodeError:
            return f"error: unexpected GitHub response\n{create_pr.stdout.strip()}"
        pr_url = response.get("html_url", "")
        pr_number = response.get("number", "")
        if not pr_url:
            return f"error: GitHub response missing html_url\n{create_pr.stdout.strip()}"
        return f"ok: opened PR #{pr_number} {pr_url}"

    def run_task(self, task: str, extra_context: str = "") -> str:
        log_activity("task_start", {"task": task[:400], "has_extra_context": bool(extra_context)})
        messages = list(self._base_messages)
        auto_docs: list[str] = []
        for url in _extract_urls(task):
            try:
                doc_path = self.fetch_documentation(url)
                auto_docs.append(f"Fetched {url} into {doc_path.relative_to(config.WORKSPACE_ROOT)}")
            except Exception as exc:
                auto_docs.append(f"Failed to fetch {url}: {exc}")

        try:
            git_context = git_history()
        except subprocess.CalledProcessError:
            git_context = ""
        task_text = f"{task}\n\nRecent git history:\n{git_context or '(empty)'}"
        if extra_context:
            task_text = f"{task_text}\n\nAdditional context:\n{extra_context}"
        if auto_docs:
            task_text = f"{task_text}\n\nURL context:\n" + "\n".join(auto_docs)
        messages.append({"role": "user", "content": [{"type": "text", "text": task_text}]})

        final_text = ""
        done = False
        steps = 0
        model = self._select_model_for_task(task)

        while not done and steps < config.MAX_STEPS:
            steps += 1
            self._emit_status(f"Step {steps}/{config.MAX_STEPS}: querying model")

            response = self.llm_client.create_message(
                model=model,
                system=self._system_prompt,
                messages=messages,
                tools=[BASH_TOOL, MAKE_PR_TOOL, PUSH_BRANCH_TOOL],
            )
            self._record_llm_usage(task, model, response.usage.input_tokens, response.usage.output_tokens)
            messages.append({"role": "assistant", "content": response.content})

            tool_uses = [block for block in response.content if block.get("type") == "tool_use"]
            if response.stop_reason == "end_turn" and not tool_uses:
                final_text = "\n".join(
                    block.get("text", "") for block in response.content if block.get("type") == "text"
                ).strip()
                done = True
                break

            tool_results: list[dict[str, object]] = []
            for tool_use in tool_uses:
                tool_name = tool_use.get("name", "bash")
                command = tool_use.get("input", {}).get("command", "")
                target_files = _extract_target_files(command)
                is_modification = _is_modification_command(command, target_files)

                if tool_name == "push_branch":
                    tier = "conditional"
                    allowed = self.approval_gate.request_approval("push branch to github", tier)
                    if not allowed:
                        result_text = "Blocked: approval denied or timed out."
                    else:
                        result_text = self._push_branch_to_remote(tool_use.get("input", {}))
                    log_activity("tool_result", {"tool": tool_name, "result": result_text[:500]})
                    tool_results.append(format_tool_result(tool_use_id=tool_use["id"], output=result_text))
                    continue

                if tool_name == "make_pr":
                    tier = "conditional"
                    allowed = self.approval_gate.request_approval("create github pull request", tier)
                    if not allowed:
                        result_text = "Blocked: approval denied or timed out."
                    else:
                        result_text = self._create_github_pr(tool_use.get("input", {}))
                    log_activity("tool_result", {"tool": tool_name, "result": result_text[:500]})
                    tool_results.append(format_tool_result(tool_use_id=tool_use["id"], output=result_text))
                    continue

                if is_modification and not self.rate_limiter.can_modify():
                    result_text = "Blocked: self-modification rate limit reached."
                else:
                    tier = classify_action(command, target_files)
                    allowed = self.approval_gate.request_approval(command, tier)
                    if not allowed:
                        result_text = "Blocked: approval denied or timed out."
                    else:
                        execution = self._execute_with_retry(command)
                        if is_modification:
                            self.rate_limiter.record_modification()
                            commit_message = f"agent: apply `{command[:80]}`"
                            try:
                                committed = git_auto_commit(commit_message)
                            except subprocess.CalledProcessError:
                                committed = False
                            append_audit_log(
                                config.TOOL_AUDIT_LOG,
                                {
                                    "command": command,
                                    "target_files": target_files,
                                    "tier": tier,
                                    "exit_code": execution.exit_code,
                                    "auto_committed": committed,
                                },
                            )
                        result_text = f"exit={execution.exit_code}\nstdout:\n{execution.stdout}\nstderr:\n{execution.stderr}"
                log_activity(
                    "tool_result",
                    {
                        "tool": tool_name,
                        "command": command,
                        "is_modification": is_modification,
                        "result_preview": result_text[:500],
                    },
                )

                tool_results.append(format_tool_result(tool_use_id=tool_use["id"], output=result_text))

            if tool_results:
                messages.append(
                    {
                        "role": "user",
                        "content": tool_results,
                    }
                )

        self._reset_conversation()
        log_activity("task_end", {"task": task[:400], "result_preview": (final_text or "")[:500]})
        return final_text or ""

    def _load_task_queue(self, tasks_path: Path) -> list[dict[str, str]]:
        if not tasks_path.exists():
            tasks_path.parent.mkdir(parents=True, exist_ok=True)
            tasks_path.write_text("[]\n", encoding="utf-8")
            return []

        raw = json.loads(tasks_path.read_text(encoding="utf-8"))
        return [dict(item) for item in raw]

    def _write_task_queue(self, tasks_path: Path, tasks: list[dict[str, str]]) -> None:
        tasks_path.parent.mkdir(parents=True, exist_ok=True)
        tasks_path.write_text(json.dumps(tasks, indent=2) + "\n", encoding="utf-8")

    def get_next_task(self, tasks_path: Path) -> ImprovementTask | None:
        tasks = self._load_task_queue(tasks_path)
        for task in tasks:
            if task.get("status") == "pending":
                task["status"] = "in-progress"
                self._write_task_queue(tasks_path, tasks)
                return ImprovementTask(
                    id=task.get("id", ""),
                    title=task.get("title", ""),
                    status=task.get("status", "pending"),
                )
        return None

    def _set_task_status(self, tasks_path: Path, task_id: str, status: str) -> None:
        tasks = self._load_task_queue(tasks_path)
        for task in tasks:
            if task.get("id") == task_id:
                task["status"] = status
        self._write_task_queue(tasks_path, tasks)

    def fetch_documentation(self, url: str, docs_root: Path | None = None) -> Path:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        if not host:
            raise ValueError("URL must include a host")
        self._ensure_domain_allowlisted(host)

        worker_markdown = self._fetch_markdown_with_cloudflare_worker(url)
        if worker_markdown:
            return self._write_doc_content(parsed=parsed, content=worker_markdown, docs_root=docs_root)

        escaped_url = quote(url, safe=":/?&=#%")
        fetch_command = (
            "curl -fsSL "
            "-A 'Mozilla/5.0 (compatible; BlobBot/1.0; +https://example.com/bot)' "
            "-H 'Accept: text/markdown, text/html;q=0.9, */*;q=0.8' "
            "-w '\n__BLOB_CONTENT_TYPE__:%{content_type}' "
            f"'{escaped_url}'"
        )
        response = self.sandbox.execute(fetch_command, timeout=config.COMMAND_TIMEOUT)
        if response.exit_code != 0:
            raise RuntimeError(f"Failed to fetch documentation: {response.stderr}")

        body, separator, content_type = response.stdout.rpartition("\n__BLOB_CONTENT_TYPE__:")
        if not separator:
            body = response.stdout
            content_type = ""
        normalized_type = content_type.split(";", 1)[0].strip().lower()

        content = body.strip()
        if normalized_type == "text/markdown":
            pass
        elif self._is_html_response(normalized_type, content):
            content = self._convert_html_response(url=url, html=content)

        return self._write_doc_content(parsed=parsed, content=content, docs_root=docs_root)

    def _write_doc_content(self, parsed, content: str, docs_root: Path | None = None) -> Path:
        parsed_url = parsed
        host = parsed_url.hostname or "unknown-host"
        root = docs_root or (config.WORKSPACE_ROOT / "docs")
        path_suffix = parsed_url.path.strip("/") or "index"
        target = root / host / f"{path_suffix}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return target

    def _fetch_markdown_with_cloudflare_worker(self, url: str) -> str | None:
        endpoint = config.CLOUDFLARE_MARKDOWN_FETCH_URL
        token = config.CLOUDFLARE_API_TOKEN
        if not endpoint:
            return None

        payload = json.dumps({"url": url})
        command_parts = [
            "curl -fsSL",
            f"-X POST {shlex.quote(endpoint)}",
            "-H 'Content-Type: application/json'",
        ]
        if token:
            command_parts.append(f"-H {shlex.quote(f'Authorization: Bearer {token}')}")
        command_parts.append(f"--data-raw {shlex.quote(payload)}")
        command = " ".join(command_parts)

        response = self.sandbox.execute(command, timeout=config.COMMAND_TIMEOUT)
        if response.exit_code != 0:
            return None

        text = response.stdout.strip()
        if not text:
            return None
        try:
            payload_obj = json.loads(text)
        except json.JSONDecodeError:
            return text

        if isinstance(payload_obj, dict):
            result_block = payload_obj.get("result")
            nested_markdown = result_block.get("markdown") if isinstance(result_block, dict) else None
            markdown = payload_obj.get("markdown") or nested_markdown
            if isinstance(markdown, str) and markdown.strip():
                return markdown.strip()
        return None

    def _is_html_response(self, content_type: str, content: str) -> bool:
        if content_type in {"text/html", "application/xhtml+xml"}:
            return True
        lowered = content.lstrip().lower()
        return lowered.startswith("<!doctype html") or lowered.startswith("<html")

    def _convert_html_response(self, url: str, html: str) -> str:
        browser_markdown = self._render_markdown_with_browser(url)
        if browser_markdown:
            return browser_markdown

        ai_markdown = self._convert_html_with_cloudflare_ai(html)
        if ai_markdown:
            return ai_markdown

        parser = _HTMLToTextParser()
        parser.feed(html)
        return parser.as_markdown() or html.strip()

    def _render_markdown_with_browser(self, url: str) -> str | None:
        endpoint = config.CLOUDFLARE_BROWSER_RENDER_MARKDOWN_URL
        token = config.CLOUDFLARE_API_TOKEN
        if not endpoint or not token:
            return None

        payload = json.dumps({"url": url})
        command = (
            "curl -fsSL "
            f"-X POST {shlex.quote(endpoint)} "
            f"-H {shlex.quote(f'Authorization: Bearer {token}')} "
            "-H 'Content-Type: application/json' "
            f"--data-raw {shlex.quote(payload)}"
        )
        response = self.sandbox.execute(command, timeout=config.COMMAND_TIMEOUT)
        if response.exit_code != 0:
            return None

        text = response.stdout.strip()
        if not text:
            return None
        try:
            payload_obj = json.loads(text)
        except json.JSONDecodeError:
            return text
        if isinstance(payload_obj, dict):
            result_block = payload_obj.get("result")
            nested_markdown = result_block.get("markdown") if isinstance(result_block, dict) else None
            markdown = payload_obj.get("markdown") or nested_markdown
            if isinstance(markdown, str) and markdown.strip():
                return markdown.strip()
        return None

    def _convert_html_with_cloudflare_ai(self, html: str) -> str | None:
        endpoint = config.CLOUDFLARE_WORKERS_AI_MARKDOWN_CONVERSION_URL or config.CLOUDFLARE_AI_TO_MARKDOWN_URL
        token = config.CLOUDFLARE_API_TOKEN
        if not endpoint or not token:
            return None

        payload = json.dumps({"html": html})
        command = (
            "curl -fsSL "
            f"-X POST {shlex.quote(endpoint)} "
            f"-H {shlex.quote(f'Authorization: Bearer {token}')} "
            "-H 'Content-Type: application/json' "
            f"--data-raw {shlex.quote(payload)}"
        )
        response = self.sandbox.execute(command, timeout=config.COMMAND_TIMEOUT)
        if response.exit_code != 0:
            return None

        try:
            payload_obj = json.loads(response.stdout)
        except json.JSONDecodeError:
            return None

        if isinstance(payload_obj, dict):
            result_block = payload_obj.get("result")
            nested_markdown = result_block.get("markdown") if isinstance(result_block, dict) else None
            markdown = payload_obj.get("markdown") or nested_markdown
            if isinstance(markdown, str) and markdown.strip():
                return markdown.strip()
        return None

    def _is_host_allowlisted(self, host: str) -> bool:
        normalized = host.lower()
        for pattern in config.NETWORK_ALLOWLIST:
            if pattern.startswith("*."):
                suffix = pattern[2:]
                if normalized == suffix or normalized.endswith(f".{suffix}"):
                    return True
            if normalized == pattern.lower():
                return True
        return False

    def _extract_base_domain(self, host: str) -> str:
        normalized = host.lower().strip(".")
        labels = normalized.split(".")
        if len(labels) <= 2:
            return normalized
        return ".".join(labels[-2:])

    def _ensure_domain_allowlisted(self, host: str) -> None:
        if self._is_host_allowlisted(host):
            return

        base_domain = self._extract_base_domain(host)
        new_patterns = [base_domain, f"*.{base_domain}"]
        existing = {item.lower() for item in config.NETWORK_ALLOWLIST}
        additions = [pattern for pattern in new_patterns if pattern.lower() not in existing]
        if not additions:
            return

        config.NETWORK_ALLOWLIST.extend(additions)

        if hasattr(self.sandbox, "allowlist") and isinstance(self.sandbox.allowlist, list):
            self.sandbox.allowlist.extend(additions)

        custom_allowlist_path = config.WORKSPACE_ROOT / ".network_allowlist"
        custom_allowlist_path.parent.mkdir(parents=True, exist_ok=True)
        current_custom = []
        if custom_allowlist_path.exists():
            current_custom = [
                line.strip()
                for line in custom_allowlist_path.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.strip().startswith("#")
            ]

        merged = sorted(dict.fromkeys([*current_custom, *additions]))
        custom_allowlist_path.write_text("\n".join(merged) + "\n", encoding="utf-8")

    def load_relevant_docs(self, task: str, docs_root: Path | None = None) -> str:
        root = docs_root or (config.WORKSPACE_ROOT / "docs")
        if not root.exists() or not any(keyword in task.lower() for keyword in ("api", "docs", "sdk", "http")):
            return ""
        snippets: list[str] = []
        for path in sorted(root.rglob("*.md")):
            snippets.append(f"## {path.relative_to(root)}\n{path.read_text()[:2000]}")
        return "\n\n".join(snippets)

    def _reflect_on_task(self, task: str, result: str) -> str | None:
        """Make a cheap LLM call to extract a reusable learning from a completed task."""
        prompt = (
            f"You just completed this task: {task}\n\n"
            f"Result summary: {result[:1000]}\n\n"
            "Did you discover any new permanent rules, patterns, or gotchas about this codebase that "
            "future sessions should know? If yes, output a SINGLE concise bullet point (starting with '- '). "
            "Focus on reusable, codebase-specific knowledge — not task-specific details. "
            "If there is no new learning worth persisting, output exactly: NONE"
        )
        try:
            response = self.llm_client.create_message(
                model=config.MODEL_ROUTING["routine"],
                system="You are a coding agent reviewing your own completed task to extract reusable learnings.",
                messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
            )
            self._record_llm_usage(
                f"reflect: {task[:60]}",
                config.MODEL_ROUTING["routine"],
                response.usage.input_tokens,
                response.usage.output_tokens,
            )
            text = "\n".join(
                block.get("text", "") for block in response.content if block.get("type") == "text"
            ).strip()
            if text and text.upper() != "NONE" and text.startswith("- "):
                return text
        except Exception:
            pass
        return None

    def update_agent_knowledge(
        self, task: str, result: str, success: bool, learning: str | None = None, agent_md_path: Path | None = None
    ) -> None:
        agent_md = agent_md_path or (config.WORKSPACE_ROOT / "AGENT.md")
        timestamp = datetime.now(timezone.utc).isoformat()
        status = "SUCCESS" if success else "FAILED"
        learning_text = learning or "No new patterns recorded."
        entry = (
            f"\n- {timestamp} [{status}]\n"
            f"  - Task: {task}\n"
            f"  - What changed: {result[:500] or 'No summary returned.'}\n"
            f"  - Learning: {learning_text}\n"
        )

        if not agent_md.exists():
            agent_md.write_text(entry, encoding="utf-8")
            return

        content = agent_md.read_text(encoding="utf-8")
        log_header = "\n## Session Log\n"
        if log_header in content:
            base, _, log_section = content.partition(log_header)
            raw_entries = re.split(r"\n(?=- \d{4}-)", log_section)
            entries = [e for e in raw_entries if e.strip()]
            entries = entries[-9:]
            entries.append(entry.lstrip("\n"))
            new_log = "\n".join(entries)
            agent_md.write_text(base + log_header + "\n" + new_log, encoding="utf-8")
        else:
            with agent_md.open("a", encoding="utf-8") as f:
                f.write(entry)

    def run_self_improvement_cycle(self, tasks_path: Path | None = None) -> list[str]:
        queue_path = tasks_path or config.TASK_QUEUE_PATH
        summaries: list[str] = []

        while True:
            next_task = self.get_next_task(queue_path)
            if not next_task:
                break

            checkpoint_tag = f"checkpoint-{next_task.id}"
            self._emit_status(f"Creating checkpoint {checkpoint_tag}")
            git_checkpoint(checkpoint_tag)

            doc_context = self.load_relevant_docs(next_task.title)
            result = self.run_task(next_task.title, extra_context=doc_context)

            test_result = self.sandbox.execute("pytest tests/", timeout=config.COMMAND_TIMEOUT)
            if test_result.exit_code == 0:
                git_auto_commit(f"self-improve: {next_task.title}")
                learning = self._reflect_on_task(next_task.title, result)
                self.update_agent_knowledge(next_task.title, result, success=True, learning=learning)
                self._set_task_status(queue_path, next_task.id, "completed")
                summaries.append(f"completed: {next_task.title}")
            else:
                git_revert_to_checkpoint(checkpoint_tag)
                self.update_agent_knowledge(next_task.title, test_result.stderr, success=False)
                self._set_task_status(queue_path, next_task.id, "pending")
                summaries.append(f"reverted: {next_task.title}")

        return summaries

    def generate_improvement_tasks(self, tasks_path: Path) -> list[str]:
        """Scan the codebase for issues and generate new pending improvement tasks."""
        test_result = self.sandbox.execute(
            "pytest tests/ --tb=short -q 2>&1 | head -60", timeout=config.COMMAND_TIMEOUT
        )
        todo_result = self.sandbox.execute(
            "grep -rn 'TODO\\|FIXME\\|HACK\\|XXX' --include='*.py' . 2>/dev/null | head -30",
            timeout=config.COMMAND_TIMEOUT,
        )
        history = git_history()
        context = (
            f"Pytest output:\n{test_result.stdout[:2000]}\n\n"
            f"TODOs/FIXMEs in codebase:\n{todo_result.stdout[:1000]}\n\n"
            f"Recent git history:\n{history}\n"
        )
        prompt = (
            "You are analyzing a codebase to identify the next most valuable self-improvement tasks.\n\n"
            f"{context}\n\n"
            "Generate exactly 3 specific, actionable improvement tasks. For each, output a line:\n"
            "TASK: <one-line description>\n\n"
            "Focus on fixing failing tests, resolving TODOs, improving error handling, adding missing "
            "functionality, or refactoring complex code. Do NOT suggest modifying: agent.py, "
            "sandbox.py, approval.py, safety.py, config.py, or slack_bot.py."
        )
        response = self.llm_client.create_message(
            model=config.MODEL_ROUTING["routine"],
            system="You are a coding agent identifying self-improvement tasks.",
            messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        )
        self._record_llm_usage(
            "generate_tasks",
            config.MODEL_ROUTING["routine"],
            response.usage.input_tokens,
            response.usage.output_tokens,
        )
        text = "\n".join(
            block.get("text", "") for block in response.content if block.get("type") == "text"
        )
        new_titles = [m.strip() for m in re.findall(r"TASK:\s*(.+)", text) if m.strip()]
        if not new_titles:
            return []

        existing = self._load_task_queue(tasks_path)
        existing_titles = {t.get("title", "") for t in existing}
        max_id = max(
            (
                int(t.get("id", "0").split("-")[-1])
                for t in existing
                if t.get("id", "").split("-")[-1].isdigit()
            ),
            default=0,
        )
        new_tasks = [
            {"id": f"auto-{max_id + i}", "title": title, "status": "pending"}
            for i, title in enumerate(new_titles, start=1)
            if title not in existing_titles
        ]
        if new_tasks:
            self._write_task_queue(tasks_path, existing + new_tasks)
        return [t["title"] for t in new_tasks]

    def _autonomous_tasks_today(self) -> tuple[str, int]:
        """Return (today_iso, count) of tasks run today in autonomous mode."""
        count_file = config.WORKSPACE_ROOT / ".autonomous_daily_count"
        today = datetime.now(timezone.utc).date().isoformat()
        if not count_file.exists():
            return today, 0
        raw = count_file.read_text().strip()
        if not raw or ":" not in raw:
            return today, 0
        day_str, count_str = raw.split(":", 1)
        if day_str != today:
            return today, 0
        return today, int(count_str)

    def _record_autonomous_task(self) -> None:
        count_file = config.WORKSPACE_ROOT / ".autonomous_daily_count"
        today, count = self._autonomous_tasks_today()
        count_file.write_text(f"{today}:{count + 1}")

    def run_autonomous_loop(self, tasks_path: Path | None = None) -> None:
        """Run a continuous self-improvement loop.

        Processes all pending tasks, then generates new ones from codebase
        signals (failing tests, TODOs, git history) when the queue runs dry.
        Respects AUTONOMOUS_DAILY_TASK_LIMIT (default 10) to control API costs.
        Runs until interrupted with Ctrl-C.
        """
        queue_path = tasks_path or config.TASK_QUEUE_PATH
        self._emit_status(
            f"Autonomous loop started (daily task limit: {config.AUTONOMOUS_DAILY_TASK_LIMIT})"
        )
        try:
            while True:
                today, tasks_today = self._autonomous_tasks_today()
                remaining = config.AUTONOMOUS_DAILY_TASK_LIMIT - tasks_today
                if remaining <= 0:
                    # Sleep until midnight UTC then reset
                    now = datetime.now(timezone.utc)
                    midnight = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
                    from datetime import timedelta
                    seconds_until_midnight = (midnight + timedelta(days=1) - now).seconds
                    self._emit_status(
                        f"Daily task limit ({config.AUTONOMOUS_DAILY_TASK_LIMIT}) reached "
                        f"({tasks_today} tasks run today). Sleeping {seconds_until_midnight}s until midnight UTC."
                    )
                    time.sleep(seconds_until_midnight + 5)
                    continue

                summaries = self.run_self_improvement_cycle(queue_path)
                for _ in summaries:
                    self._record_autonomous_task()
                if summaries:
                    self._emit_status(f"Cycle complete: {summaries}")

                tasks = self._load_task_queue(queue_path)
                pending = [t for t in tasks if t.get("status") == "pending"]
                if not pending:
                    self._emit_status("Queue empty — scanning codebase for new improvement tasks")
                    new_tasks = self.generate_improvement_tasks(queue_path)
                    if new_tasks:
                        self._emit_status(f"Generated {len(new_tasks)} new tasks: {new_tasks}")
                    else:
                        self._emit_status(
                            f"No new tasks generated; sleeping {config.AUTONOMOUS_LOOP_INTERVAL}s"
                        )
                        time.sleep(config.AUTONOMOUS_LOOP_INTERVAL)
        except KeyboardInterrupt:
            self._emit_status("Autonomous loop stopped")

    def _execute_with_retry(self, command: str) -> "ExecutionResult":
        """Execute a command with exponential-backoff retries on transient failures.

        Retries are skipped for sandbox policy rejections and approval blocks since
        those are deterministic and re-running the command would not change the outcome.
        """
        from sandbox import ExecutionResult  # local import to avoid circularity at module level

        last_result: ExecutionResult | None = None
        for attempt in range(config.TOOL_RETRY_MAX + 1):
            result = self.sandbox.execute(command=command, timeout=config.COMMAND_TIMEOUT)
            if result.exit_code == 0:
                return result
            # Non-retryable: sandbox policy blocks are deterministic.
            if "Command rejected by sandbox policy" in result.stderr:
                return result
            last_result = result
            if attempt < config.TOOL_RETRY_MAX:
                wait = config.TOOL_RETRY_BACKOFF_BASE ** attempt
                self._emit_status(
                    f"Tool call failed (exit={result.exit_code}), retrying in {wait:.1f}s"
                    f" (attempt {attempt + 1}/{config.TOOL_RETRY_MAX})"
                )
                time.sleep(wait)
        return last_result  # type: ignore[return-value]  # always set after first iteration

    def _reset_conversation(self) -> None:
        self._base_messages = []


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the self-modifying agent")
    parser.add_argument("task", nargs="?", help="Task description to execute")
    parser.add_argument("--self-improve", action="store_true", help="Run the self-improvement task queue once")
    parser.add_argument(
        "--autonomous",
        action="store_true",
        help="Run continuous self-improvement loop (also enabled by AUTONOMOUS_MODE=true env var)",
    )
    args = parser.parse_args()

    from llm_client import AnthropicClient
    from sandbox import FlySpriteSandbox

    class AutoApprove(ApprovalGate):
        def request_approval(self, action_description: str, tier: str) -> bool:
            return tier == "auto-approve"

    autonomous = args.autonomous or config.AUTONOMOUS_MODE
    approval_gate: ApprovalGate = AutonomousApprovalGate() if autonomous else AutoApprove()

    agent = Agent(
        llm_client=AnthropicClient(),
        sandbox=FlySpriteSandbox(),
        approval_gate=approval_gate,
    )

    if autonomous:
        agent.run_autonomous_loop()
    elif args.self_improve:
        result = {"summary": agent.run_self_improvement_cycle()}
        print(json.dumps(result, indent=2))
    else:
        if not args.task:
            raise SystemExit("task is required unless --self-improve or --autonomous is provided")
        result = {"result": agent.run_task(args.task)}
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
