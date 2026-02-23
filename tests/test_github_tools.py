"""Tests for github_tools.py."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

import github_tools


def _make_response(data: dict):
    body = json.dumps(data).encode()
    mock = MagicMock()
    mock.__enter__ = MagicMock(return_value=mock)
    mock.__exit__ = MagicMock(return_value=False)
    mock.read.return_value = body
    return mock


@pytest.fixture(autouse=True)
def set_github_token(monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "test-token")


class TestGetToken:
    def test_returns_token(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "my-token")
        assert github_tools._get_token() == "my-token"

    def test_raises_when_missing(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match=r"GITHUB_TOKEN \(or GH_TOKEN\)"):
            github_tools._get_token()

    def test_falls_back_to_gh_token(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.setenv("GH_TOKEN", "legacy-token")
        assert github_tools._get_token() == "legacy-token"


class TestApiRequest:
    def test_get_request(self):
        response_data = {"login": "kyleboas"}
        with patch("github_tools.urlopen", return_value=_make_response(response_data)):
            result = github_tools._api_request("GET", "/user")
        assert result == response_data

    def test_post_request_with_body(self):
        response_data = {"number": 42, "html_url": "https://github.com/o/r/pull/42"}
        with patch("github_tools.urlopen", return_value=_make_response(response_data)):
            result = github_tools._api_request("POST", "/repos/o/r/pulls", {"title": "fix"})
        assert result["number"] == 42

    def test_http_error_raises_runtime_error(self):
        from urllib.error import HTTPError

        err = HTTPError(url="u", code=422, msg="Unprocessable", hdrs=None, fp=None)
        err.read = MagicMock(return_value=b'{"message":"Validation Failed"}')
        with patch("github_tools.urlopen", side_effect=err):
            with pytest.raises(RuntimeError, match="422"):
                github_tools._api_request("POST", "/repos/o/r/pulls", {})

    def test_includes_auth_header(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
        captured = {}

        def fake_urlopen(req, timeout=None):
            captured["auth"] = req.get_header("Authorization")
            return _make_response({})

        with patch("github_tools.urlopen", side_effect=fake_urlopen):
            github_tools._api_request("GET", "/user")

        assert captured["auth"] == "Bearer secret-token"


class TestGetAuthenticatedUser:
    def test_returns_user_info(self):
        user_data = {"login": "kyleboas", "name": "Kyle Boas"}
        with patch("github_tools.urlopen", return_value=_make_response(user_data)):
            result = github_tools.get_authenticated_user()
        assert result["login"] == "kyleboas"


class TestGetRepo:
    def test_returns_repo_info(self):
        repo_data = {"default_branch": "main", "full_name": "kyleboas/blob"}
        with patch("github_tools.urlopen", return_value=_make_response(repo_data)):
            result = github_tools.get_repo("kyleboas", "blob")
        assert result["default_branch"] == "main"


class TestForkRepo:
    def test_returns_fork_info(self):
        fork_data = {
            "clone_url": "https://github.com/blob-bot/blob.git",
            "full_name": "blob-bot/blob",
        }
        with patch("github_tools.urlopen", return_value=_make_response(fork_data)):
            result = github_tools.fork_repo("kyleboas", "blob")
        assert result["full_name"] == "blob-bot/blob"


class TestCreatePullRequest:
    def test_creates_pr_with_explicit_base(self):
        pr_data = {"number": 1, "html_url": "https://github.com/kyleboas/blob/pull/1"}
        with patch("github_tools.urlopen", return_value=_make_response(pr_data)):
            result = github_tools.create_pull_request(
                owner="kyleboas",
                repo="blob",
                title="Fix bug",
                body="Description",
                head="blob/fix-bug",
                base="main",
            )
        assert result["number"] == 1
        assert "pull/1" in result["html_url"]

    def test_fetches_default_branch_when_base_empty(self):
        repo_data = {"default_branch": "main"}
        pr_data = {"number": 2, "html_url": "https://github.com/kyleboas/blob/pull/2"}
        responses = [_make_response(repo_data), _make_response(pr_data)]
        with patch("github_tools.urlopen", side_effect=responses):
            result = github_tools.create_pull_request(
                owner="kyleboas",
                repo="blob",
                title="Add feature",
                body="",
                head="blob/add-feature",
                base="",
            )
        assert result["number"] == 2

    def test_draft_pr(self):
        pr_data = {
            "number": 3,
            "html_url": "https://github.com/kyleboas/blob/pull/3",
            "draft": True,
        }
        with patch("github_tools.urlopen", return_value=_make_response(pr_data)):
            result = github_tools.create_pull_request(
                owner="kyleboas",
                repo="blob",
                title="Draft fix",
                body="",
                head="blob/draft-fix",
                base="main",
                draft=True,
            )
        assert result["draft"] is True


class TestAuthenticatedRemoteUrl:
    def test_embeds_token_in_url(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "abc123")
        url = github_tools.authenticated_remote_url("kyleboas", "blob")
        assert url == "https://abc123@github.com/kyleboas/blob.git"

    def test_raises_when_token_missing(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        monkeypatch.delenv("GH_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match=r"GITHUB_TOKEN \(or GH_TOKEN\)"):
            github_tools.authenticated_remote_url("kyleboas", "blob")
