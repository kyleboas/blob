import type { Env } from "./types";

export interface RepoConfig {
  scope: string;
  owner: string;
  repo: string;
  baseBranch: string;
  autoMerge?: boolean;
}

const REPO_CONFIG_PREFIX = "config/repos/";

export async function setRepoConfig(env: Env, config: RepoConfig): Promise<void> {
  await env.REPO_STORE.put(`${REPO_CONFIG_PREFIX}${config.scope}.json`, JSON.stringify(config));
}

export async function getRepoConfig(env: Env, scope: string): Promise<RepoConfig | null> {
  const obj = await env.REPO_STORE.get(`${REPO_CONFIG_PREFIX}${scope}.json`);
  if (!obj) return null;
  return (await obj.json()) as RepoConfig;
}

export async function listRepoConfigs(env: Env): Promise<RepoConfig[]> {
  const listed = await env.REPO_STORE.list({ prefix: REPO_CONFIG_PREFIX });
  const configs = await Promise.all(
    listed.objects.map(async (item) => {
      const obj = await env.REPO_STORE.get(item.key);
      return obj ? ((await obj.json()) as RepoConfig) : null;
    }),
  );
  return configs.filter((c): c is RepoConfig => c !== null);
}

export function resolveTargetRepo(configs: RepoConfig[], requested?: string): { config?: RepoConfig; clarification?: string } {
  if (requested) {
    const match = configs.find((c) => `${c.owner}/${c.repo}` === requested || c.repo === requested);
    if (match) return { config: match };
    return { clarification: `I couldn't find repo \"${requested}\". Available repos: ${configs.map((c) => `${c.owner}/${c.repo}`).join(", ")}.` };
  }

  if (configs.length === 1) return { config: configs[0] };
  return {
    clarification:
      "Multiple repos are configured. Please specify which repo to use: " +
      configs.map((c) => `${c.owner}/${c.repo}`).join(", "),
  };
}

export function buildPrIdempotencyKey(featureBranch: string, commitHash: string): string {
  return `${featureBranch}:${commitHash}`;
}

export function buildMergeIdempotencyKey(prNumber: number, mergeSha: string): string {
  return `${prNumber}:${mergeSha}`;
}

export interface ConflictAnalysis {
  ok: boolean;
  conflict: boolean;
  summary: string;
}

export function analyzePrePushSyncResult(exitCode: number, stdout: string, stderr: string): ConflictAnalysis {
  if (exitCode === 0) {
    return { ok: true, conflict: false, summary: "Up to date with base branch" };
  }

  const combined = `${stdout}\n${stderr}`.toLowerCase();
  const conflict =
    combined.includes("conflict") || combined.includes("merge conflict") || combined.includes("could not apply");

  return {
    ok: false,
    conflict,
    summary: conflict ? "Rebase/merge conflict detected. Waiting for user instruction." : "Sync with base branch failed.",
  };
}

const DEFAULT_SECRET_PATTERNS = [
  /api[_-]?key\s*[=:]\s*[\"']?[a-z0-9_\-]{10,}/i,
  /token\s*[=:]\s*[\"']?[a-z0-9_\-]{10,}/i,
  /password\s*[=:]\s*[\"']?\S{8,}/i,
  /-----begin (rsa |ec )?private key-----/i,
];

export function scanDiffForSecrets(diffText: string, patterns: RegExp[] = DEFAULT_SECRET_PATTERNS): { blocked: boolean; matches: string[] } {
  const matches: string[] = [];
  const lines = diffText.split("\n").filter((line) => line.startsWith("+"));
  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        matches.push(line.slice(0, 200));
        break;
      }
    }
  }
  return { blocked: matches.length > 0, matches };
}

export function buildSandboxRepoSetupCommands(config: RepoConfig, featureBranch: string): string[] {
  const repoSlug = `${config.owner}/${config.repo}`;
  const repoDir = config.repo;
  return [
    `rm -rf ${repoDir}`,
    `git clone https://github.com/${repoSlug}.git ${repoDir}`,
    `cd ${repoDir} && git checkout ${config.baseBranch}`,
    `cd ${repoDir} && git checkout -b ${featureBranch}`,
  ];
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: string;
}

export class GitHubApi {
  constructor(private token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(path: string, init: RequestInit, idempotencyKey?: string): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/vnd.github+json");
    if (idempotencyKey) headers.set("x-idempotency-key", idempotencyKey);

    const response = await this.fetchImpl(`https://api.github.com${path}`, { ...init, headers });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${path} failed: ${response.status} ${text}`);
    }
    return response;
  }

  async createPullRequest(params: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    head: string;
    base: string;
    idempotencyKey: string;
  }): Promise<GitHubPullRequest> {
    const response = await this.request(
      `/repos/${params.owner}/${params.repo}/pulls`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: params.title, body: params.body, head: params.head, base: params.base }),
      },
      params.idempotencyKey,
    );
    return (await response.json()) as GitHubPullRequest;
  }

  async mergePullRequest(params: {
    owner: string;
    repo: string;
    pullNumber: number;
    mergeSha: string;
    method?: "merge" | "squash" | "rebase";
  }): Promise<{ merged: boolean; message: string; sha?: string }> {
    const response = await this.request(
      `/repos/${params.owner}/${params.repo}/pulls/${params.pullNumber}/merge`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha: params.mergeSha, merge_method: params.method ?? "squash" }),
      },
      buildMergeIdempotencyKey(params.pullNumber, params.mergeSha),
    );
    return (await response.json()) as { merged: boolean; message: string; sha?: string };
  }

  async getPullChecks(params: { owner: string; repo: string; ref: string }): Promise<{ state: string }> {
    const response = await this.request(`/repos/${params.owner}/${params.repo}/commits/${params.ref}/status`, { method: "GET" });
    return (await response.json()) as { state: string };
  }
}
