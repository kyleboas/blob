"""GitHub API utilities for Blob — pull request creation and repository operations.

Usage (from bash via the agent):
    python github_tools.py whoami
    python github_tools.py create-pr --owner kyleboas --repo blob \\
        --title "Fix typo" --body "..." --head blob/fix-typo
    python github_tools.py fork --owner kyleboas --repo some-repo
    python github_tools.py remote-url --owner kyleboas --repo blob

Requires GITHUB_TOKEN (preferred) or GH_TOKEN in the environment (a classic or
fine-grained PAT with repo scope for private repos or public_repo for public repos).
"""

from __future__ import annotations

import argparse
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen

GITHUB_API = "https://api.github.com"


def _get_token() -> str:
    token = os.getenv("GITHUB_TOKEN") or os.getenv("GH_TOKEN") or ""
    if not token:
        raise RuntimeError("GITHUB_TOKEN (or GH_TOKEN) environment variable is not set")
    return token


def _api_request(method: str, path: str, body: dict | None = None) -> dict:
    token = _get_token()
    url = f"{GITHUB_API}{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Blob-Agent/1.0",
        "Content-Type": "application/json",
    }
    data = json.dumps(body).encode() if body is not None else None
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as exc:
        error_body = exc.read().decode()
        raise RuntimeError(f"GitHub API error {exc.code}: {error_body}") from exc


def get_authenticated_user() -> dict:
    """Return info about the currently authenticated GitHub user."""
    return _api_request("GET", "/user")


def get_repo(owner: str, repo: str) -> dict:
    """Return repository metadata (includes default_branch, visibility, etc.)."""
    return _api_request("GET", f"/repos/{owner}/{repo}")


def fork_repo(owner: str, repo: str) -> dict:
    """Fork a repository into the authenticated user's account."""
    return _api_request("POST", f"/repos/{owner}/{repo}/forks", {})


def create_pull_request(
    owner: str,
    repo: str,
    title: str,
    body: str,
    head: str,
    base: str = "",
    draft: bool = False,
) -> dict:
    """Create a pull request and return the PR object.

    Args:
        owner: Repository owner (user or org).
        repo: Repository name.
        title: PR title.
        body: PR description in markdown.
        head: Head branch, e.g. ``blob/fix-typo`` (same repo) or
              ``username:branch`` (cross-fork).
        base: Base branch to merge into. Defaults to the repo's default branch.
        draft: If True, open as a draft PR.

    Returns:
        GitHub PR object dict with at least ``html_url`` and ``number``.
    """
    if not base:
        base = get_repo(owner, repo).get("default_branch", "main")
    return _api_request(
        "POST",
        f"/repos/{owner}/{repo}/pulls",
        {"title": title, "body": body, "head": head, "base": base, "draft": draft},
    )


def authenticated_remote_url(owner: str, repo: str) -> str:
    """Return a git remote URL that embeds a GitHub token for push access.

    Suitable for use in ``git remote set-url origin <url>`` so that
    ``git push`` authenticates automatically without prompting.
    """
    token = _get_token()
    return f"https://{token}@github.com/{owner}/{repo}.git"


def main() -> None:
    parser = argparse.ArgumentParser(description="GitHub API tools for Blob")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # whoami
    subparsers.add_parser("whoami", help="Show authenticated GitHub user")

    # create-pr
    pr_parser = subparsers.add_parser("create-pr", help="Open a pull request")
    pr_parser.add_argument("--owner", required=True, help="Repo owner (user or org)")
    pr_parser.add_argument("--repo", required=True, help="Repo name")
    pr_parser.add_argument("--title", required=True, help="PR title")
    pr_parser.add_argument("--body", default="", help="PR description (markdown)")
    pr_parser.add_argument(
        "--head",
        required=True,
        help="Head branch, e.g. blob/fix-typo or username:branch",
    )
    pr_parser.add_argument("--base", default="", help="Base branch (default: repo default)")
    pr_parser.add_argument("--draft", action="store_true", help="Open as draft PR")

    # fork
    fork_parser = subparsers.add_parser("fork", help="Fork a repository")
    fork_parser.add_argument("--owner", required=True)
    fork_parser.add_argument("--repo", required=True)

    # remote-url
    url_parser = subparsers.add_parser(
        "remote-url",
        help="Print authenticated git remote URL (token embedded)",
    )
    url_parser.add_argument("--owner", required=True)
    url_parser.add_argument("--repo", required=True)

    args = parser.parse_args()

    if args.command == "whoami":
        user = get_authenticated_user()
        print(json.dumps({"login": user["login"], "name": user.get("name")}, indent=2))

    elif args.command == "create-pr":
        pr = create_pull_request(
            owner=args.owner,
            repo=args.repo,
            title=args.title,
            body=args.body,
            head=args.head,
            base=args.base,
            draft=args.draft,
        )
        print(json.dumps({"url": pr["html_url"], "number": pr["number"]}, indent=2))

    elif args.command == "fork":
        fork = fork_repo(args.owner, args.repo)
        print(
            json.dumps(
                {"clone_url": fork["clone_url"], "full_name": fork["full_name"]},
                indent=2,
            )
        )

    elif args.command == "remote-url":
        print(authenticated_remote_url(args.owner, args.repo))


if __name__ == "__main__":
    main()
