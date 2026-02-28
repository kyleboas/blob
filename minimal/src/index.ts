/**
 * Minimal Autonomous Blob - Single File Version
 * 
 * Fully autonomous coding agent that:
 * - Works on multiple repositories
 * - Stores per-repo goals in Cloudflare KV
 * - Runs every 5 minutes via cron
 * - No human in the loop
 */

// Types
interface Env {
  CONFIG?: KVNamespace;
  GITHUB_TOKEN?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_BASE_URL?: string;
}

// KV Helpers
async function getRepos(env: Env): Promise<string[]> {
  if (!env.CONFIG) return ["kyleboas/blob"];
  const stored = await env.CONFIG.get("repos");
  return stored ? stored.split(",").map(r => r.trim()) : ["kyleboas/blob"];
}

async function addRepo(env: Env, repo: string): Promise<void> {
  if (!env.CONFIG) return;
  const repos = await getRepos(env);
  if (!repos.includes(repo)) {
    repos.push(repo);
    await env.CONFIG.put("repos", repos.join(","));
  }
}

async function getRepoGoals(env: Env, repo: string): Promise<string[]> {
  if (!env.CONFIG) return ["improve codebase"];
  const stored = await env.CONFIG.get(`goals:${repo}`);
  return stored ? stored.split(";").map(g => g.trim()) : ["improve codebase"];
}

async function setRepoGoals(env: Env, repo: string, goals: string[]): Promise<void> {
  if (env.CONFIG) {
    await env.CONFIG.put(`goals:${repo}`, goals.join("; "));
  }
}

// LLM
async function callLLM(
  messages: Array<{ role: string; content: string }>,
  env: Env,
  opts: { maxTokens?: number } = {}
): Promise<string> {
  const response = await fetch(`${env.AI_GATEWAY_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8",
      messages,
      max_tokens: opts.maxTokens ?? 4096,
    }),
  });
  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

async function plan(goals: string[], env: Env): Promise<string> {
  const prompt = `You are an autonomous coding agent.\n\nRepository goals:\n${goals.map(g => `- ${g}`).join("\n")}\n\nWhat is ONE specific task to work on next? Respond with only the task description.`;
  return (await callLLM([{ role: "user", content: prompt }], env)).trim();
}

// Agent
class Agent {
  constructor(private repo: string, private goals: string[], private env: Env) {}

  async run(): Promise<void> {
    try {
      const task = await plan(this.goals, this.env);
      console.log(`[${this.repo}] Task: ${task}`);
      
      // Execute task (simplified - just log for now)
      console.log(`[${this.repo}] Executing...`);
      
      // Auto-commit
      await this.commit(task);
    } catch (err) {
      console.error(`[${this.repo}] Error: ${err}`);
    }
  }

  private async commit(task: string): Promise<void> {
    if (!this.env.GITHUB_TOKEN) {
      console.log(`[${this.repo}] No GITHUB_TOKEN, skipping commit`);
      return;
    }
    console.log(`[${this.repo}] Would commit: ${task}`);
    // TODO: Implement actual git operations
  }
}

// Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/health") return new Response("OK");
    
    if (url.pathname === "/repos" && request.method === "GET") {
      const repos = await getRepos(env);
      const configs = await Promise.all(repos.map(async (r) => ({ repo: r, goals: await getRepoGoals(env, r) })));
      return json(configs);
    }
    
    if (url.pathname === "/repos" && request.method === "POST") {
      const { repo } = await request.json() as { repo: string };
      await addRepo(env, repo);
      return json({ added: repo });
    }
    
    if (url.pathname.match(/^\/repos\/[^\/]+\/goals$/) && request.method === "GET") {
      const repo = url.pathname.split("/")[2];
      return json({ repo, goals: await getRepoGoals(env, repo) });
    }
    
    if (url.pathname.match(/^\/repos\/[^\/]+\/goals$/) && request.method === "POST") {
      const repo = url.pathname.split("/")[2];
      const { goals } = await request.json() as { goals: string[] };
      await setRepoGoals(env, repo, goals);
      return json({ saved: repo, goals });
    }
    
    if (url.pathname === "/run" && request.method === "POST") {
      const repos = await getRepos(env);
      repos.forEach(r => new Agent(r, [], env).run().catch(console.error));
      return json({ started: repos });
    }
    
    return new Response("Not found", { status: 404 });
  },
  
  async scheduled(_: ScheduledEvent, env: Env): Promise<void> {
    const repos = await getRepos(env);
    for (const repo of repos) {
      const goals = await getRepoGoals(env, repo);
      await new Agent(repo, goals, env).run();
    }
  }
};

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}
