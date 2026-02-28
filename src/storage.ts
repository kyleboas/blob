import type { Env } from "./types";

const BLOB_ID = "blob";

async function getBlobDO(env: Env): Promise<DurableObjectStub> {
  if (!env.BLOB) throw new Error("BLOB binding not found");
  const id = env.BLOB.idFromName(BLOB_ID);
  return env.BLOB.get(id);
}

export async function getRepos(env: Env): Promise<string[]> {
  try {
    const do_ = await getBlobDO(env);
    const res = await do_.fetch("http://do/repos");
    const data = await res.json() as { repos: string[] };
    return data.repos;
  } catch {
    return ["kyleboas/blob"];
  }
}

export async function addRepo(env: Env, repo: string): Promise<void> {
  try {
    const do_ = await getBlobDO(env);
    await do_.fetch("http://do/repos", {
      method: "POST",
      body: JSON.stringify({ repo }),
    });
  } catch {
    // Ignore errors
  }
}

export async function getRepoGoals(env: Env, repo: string): Promise<string[]> {
  try {
    const do_ = await getBlobDO(env);
    const res = await do_.fetch(`http://do/goals?repo=${encodeURIComponent(repo)}`);
    const data = await res.json() as { goals: string[] };
    return data.goals;
  } catch {
    return ["improve codebase"];
  }
}

export async function setRepoGoals(env: Env, repo: string, goals: string[]): Promise<void> {
  try {
    const do_ = await getBlobDO(env);
    await do_.fetch("http://do/goals", {
      method: "POST",
      body: JSON.stringify({ repo, goals }),
    });
  } catch {
    // Ignore errors
  }
}