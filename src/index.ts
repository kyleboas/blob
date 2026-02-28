import type { Env } from "./types";
import { AgentDO } from "./do";
import { getRepos, addRepo, getRepoGoals, setRepoGoals } from "./storage";
import { Agent } from "./agent";
import { handleSlackEvent } from "./slack";
import { triggerCatalogUpdate } from "./memory";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Slack webhook endpoint
    if (url.pathname === "/slack/events") {
      return handleSlackEvent(request, env);
    }
    
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

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const cron = event.cron;
    
    // Weekly cron: Update model catalog
    if (cron === "0 0 * * 0") {
      const result = await triggerCatalogUpdate(env);
      console.log("Catalog update:", result);
      return;
    }
    
    // Every 5 minutes: Run agent on repos
    const repos = await getRepos(env);
    for (const repo of repos) {
      const goals = await getRepoGoals(env, repo);
      await new Agent(repo, goals, env).run();
    }
  }
};

export { AgentDO };
