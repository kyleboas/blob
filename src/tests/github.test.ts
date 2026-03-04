import test from "node:test";
import assert from "node:assert/strict";
import {
  GitHubApi,
  analyzePrePushSyncResult,
  buildPrIdempotencyKey,
  resolveTargetRepo,
  scanDiffForSecrets,
  type RepoConfig,
} from "../integrations/github";

test("buildPrIdempotencyKey uses branch+commit", () => {
  assert.equal(buildPrIdempotencyKey("feat/test", "abc123"), "feat/test:abc123");
});

test("analyzePrePushSyncResult detects conflicts", () => {
  const result = analyzePrePushSyncResult(1, "", "CONFLICT (content): Merge conflict in src/index.ts");
  assert.equal(result.conflict, true);
  assert.equal(result.ok, false);
});

test("scanDiffForSecrets blocks obvious secrets", () => {
  const diff = `+const API_KEY = \"secretsecretsecret\"\n+const x = 1`;
  const result = scanDiffForSecrets(diff);
  assert.equal(result.blocked, true);
  assert.equal(result.matches.length, 1);
});

test("resolveTargetRepo asks for clarification when ambiguous", () => {
  const repos: RepoConfig[] = [
    { scope: "team:A", owner: "acme", repo: "api", baseBranch: "main" },
    { scope: "team:A", owner: "acme", repo: "web", baseBranch: "main" },
  ];
  const result = resolveTargetRepo(repos);
  assert.equal(Boolean(result.clarification), true);
  assert.equal(result.config, undefined);
});

test("GitHubApi includes idempotency key for PR creation", async () => {
  let capturedHeader = "";
  const api = new GitHubApi("token", (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeader = new Headers(init?.headers).get("x-idempotency-key") || "";
    return new Response(JSON.stringify({ number: 1, html_url: "https://github.com/acme/api/pull/1", state: "open" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);

  const pr = await api.createPullRequest({
    owner: "acme",
    repo: "api",
    title: "feat: test",
    body: "body",
    head: "feat/test",
    base: "main",
    idempotencyKey: "feat/test:abc123",
  });

  assert.equal(pr.number, 1);
  assert.equal(capturedHeader, "feat/test:abc123");
});

test("GitHubApi retries when rate limited", async () => {
  let calls = 0;
  const api = new GitHubApi("token", (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify({ state: "success" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);

  const result = await api.getPullChecks({ owner: "acme", repo: "api", ref: "abc" });
  assert.equal(result.state, "success");
  assert.equal(calls, 2);
});

test("scanDiffForSecrets supports configured regex patterns", () => {
  const result = scanDiffForSecrets('+const CUSTOM = "topsecret"', [/topsecret/i]);
  assert.equal(result.blocked, true);
});
