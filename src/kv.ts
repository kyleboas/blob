import type { Env } from "./types";

export async function getRepos(env: Env): Promise<string[]> {
  if (!env.CONFIG) return ["kyleboas/blob"];
  const stored = await env.CONFIG.get("repos");
  return stored ? stored.split(",").map(r => r.trim()) : ["kyleboas/blob"];
}

export async function addRepo(env: Env, repo: string): Promise<void> {
  if (!env.CONFIG) return;
  const repos = await getRepos(env);
  if (!repos.includes(repo)) {
    repos.push(repo);
    await env.CONFIG.put("repos", repos.join(","));
  }
}

export async function getRepoGoals(env: Env, repo: string): Promise<string[]> {
  if (!env.CONFIG) return ["improve codebase"];
  const stored = await env.CONFIG.get(`goals:${repo}`);
  return stored ? stored.split(";").map(g => g.trim()) : ["improve codebase"];
}

export async function setRepoGoals(env: Env, repo: string, goals: string[]): Promise<void> {
  if (env.CONFIG) {
    await env.CONFIG.put(`goals:${repo}`, goals.join("; "));
  }
}
