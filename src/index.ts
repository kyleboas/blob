import type { Env } from "./types";
import { AgentDO } from "./do";
import { getRepos, addRepo, getRepoGoals, setRepoGoals } from "./storage";
import { handleSlackEvent } from "./slack";
import { executeInSandbox, ensureRepoReady, finalizeRepoChanges } from "./sandbox";
import { triggerCatalogUpdate } from "./memory";
import { PiAgent } from "./pi-agent";
import { handlePiRequest } from "./pi-routes";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

interface AutonomousRunResult {
  agentSummary: string;
  gitSummary: string;
  branch?: string;
  commit?: string;
}

async function runPiAutonomousTask(repo: string, goals: string[], env: Env): Promise<AutonomousRunResult> {
  await ensureRepoReady(repo, env);

  const agent = new PiAgent(env, repo);
  const prompt = `Autonomously improve this repository in one small safe iteration.

Constraints:
- Use only the 4 core tools for code changes: read, write, edit, bash.
- Make one focused improvement aligned with goals.
- Run lightweight validation (for example npm test or npx tsc --noEmit when available).
- Do NOT run git commit or git push yourself; the orchestrator handles that step.
- Output a concise summary of what changed and test results.

Goals:
${goals.length ? goals.map((goal) => `- ${goal}`).join("\n") : "- improve codebase"}`;

  const agentSummary = await agent.run(prompt);
  const firstLine = agentSummary.split("\n").find((line) => line.trim().length > 0) ?? "autonomous update";
  const finalize = await finalizeRepoChanges(repo, env, {
    commitMessage: `blob: ${firstLine}`,
  });

  return {
    agentSummary,
    gitSummary: finalize.message,
    branch: finalize.branch,
    commit: finalize.commit,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/pi/")) {
      return handlePiRequest(request, env);
    }

    // Sandbox health check
    if (url.pathname === "/sandbox/health") {
      try {
        const result = await executeInSandbox("echo 'sandbox is alive'", env);
        return json({
          ok: true,
          sandbox: "connected",
          execResult: result.stdout
        });
      } catch (e) {
        return json({
          ok: false,
          sandbox: "error",
          error: String(e)
        }, 503);
      }
    }

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
      const started: Array<{ repo: string; status: string; details?: string }> = [];

      for (const repo of repos) {
        try {
          const goals = await getRepoGoals(env, repo);
          const result = await runPiAutonomousTask(repo, goals, env);
          started.push({
            repo,
            status: "ok",
            details: `${result.agentSummary.slice(0, 800)}\n\nGit: ${result.gitSummary}`,
          });
        } catch (error) {
          started.push({ repo, status: "error", details: String(error) });
        }
      }

      return json({ started });
    }

    return json({ error: "Not found", path: url.pathname });
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
      try {
        const goals = await getRepoGoals(env, repo);
        const result = await runPiAutonomousTask(repo, goals, env);
        console.log(`[${repo}] Pi run complete`, `${result.gitSummary} | ${result.agentSummary.slice(0, 180)}`);
      } catch (error) {
        console.error(`[${repo}] Pi run failed`, error);
      }
    }
  }
};

export { AgentDO };
