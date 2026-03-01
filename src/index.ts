import type { Env } from "./types";
import { AgentDO } from "./do";
import { Sandbox } from "./sandbox-do";
import { getRepos, addRepo, getRepoGoals, setRepoGoals } from "./storage";
import { Agent } from "./agent";
import { handleSlackEvent } from "./slack";
import { triggerCatalogUpdate } from "./memory";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function parseCodexLoginOutput(output: string): { url?: string; code?: string } {
  const urlMatch = output.match(/https:\/\/[^\s)\]]+/i);
  const codeMatch = output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{8})\b/);

  return {
    url: urlMatch?.[0],
    code: codeMatch?.[1],
  };
}

// Get sandbox instance for executing commands in container
async function getSandbox(env: Env) {
  // For now, use the DO-based approach
  // In the future, this could use @cloudflare/sandbox SDK
  if (!env.SANDBOX_DO) {
    throw new Error("SANDBOX_DO binding not found");
  }
  const id = env.SANDBOX_DO.idFromName("default");
  return env.SANDBOX_DO.get(id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Health check
    if (url.pathname === '/health') {
      return json({ status: 'healthy' });
    }
    
    // Execute command in sandbox container
    if (url.pathname === '/execute' && request.method === 'POST') {
      try {
        const { command } = await request.json() as { command: string };
        const sandbox = await getSandbox(env);
        
        // Forward to sandbox DO which runs in container
        const result = await sandbox.fetch("http://sandbox/execute", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command }),
        });
        
        return result;
      } catch (err: any) {
        return json({ 
          stdout: '', 
          stderr: String(err), 
          exitCode: 1 
        });
      }
    }
    
    // Codex login start
    if (url.pathname === '/codex/login/start' && request.method === 'POST') {
      try {
        const sandbox = await getSandbox(env);
        
        // Run codex login in container
        const result = await sandbox.fetch("http://sandbox/codex/login/start", {
          method: "POST",
        });
        
        return result;
      } catch (err: any) {
        return json({
          instructions: 'Codex login failed.',
          error: String(err)
        });
      }
    }
    
    // Codex status
    if (url.pathname === '/codex/status' && request.method === 'GET') {
      try {
        const sandbox = await getSandbox(env);
        const result = await sandbox.fetch("http://sandbox/codex/status");
        return result;
      } catch (err) {
        return json({
          authenticated: false,
          error: String(err)
        });
      }
    }
    
    // Codex auth save
    if (url.pathname === '/codex/auth/save' && request.method === 'POST') {
      try {
        const sandbox = await getSandbox(env);
        const result = await sandbox.fetch("http://sandbox/codex/auth/save", {
          method: "POST",
        });
        return result;
      } catch (err) {
        return json({ saved: false, error: String(err) });
      }
    }
    
    // Codex run
    if (url.pathname === '/codex/run' && request.method === 'POST') {
      try {
        const { prompt } = await request.json() as { prompt: string };
        const sandbox = await getSandbox(env);
        
        const result = await sandbox.fetch("http://sandbox/codex/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt }),
        });
        
        return result;
      } catch (err) {
        return json({ stdout: '', stderr: String(err), exitCode: 1 });
      }
    }
    
    // Main worker routes
    if (url.pathname === "/slack/events") {
      return handleSlackEvent(request, env);
    }
    
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

    return json({ error: 'Not found', path: url.pathname });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const cron = event.cron;
    
    if (cron === "0 0 * * 0") {
      const result = await triggerCatalogUpdate(env);
      console.log("Catalog update:", result);
      return;
    }
    
    const repos = await getRepos(env);
    for (const repo of repos) {
      const goals = await getRepoGoals(env, repo);
      await new Agent(repo, goals, env).run();
    }
  }
};

export { AgentDO, Sandbox };