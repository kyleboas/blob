import type { Env } from "../core/types";
import type { BlobState } from "./do";
import { getEffectiveHeartbeatConfig } from "./do-alarm";
import {
  handleCreateCronJob,
  handleDeleteCronJob,
  handleListCronJobs,
  handleListCronOutcomes,
  handleSaveCronOutcome,
} from "./handlers/cron";
import { handleCheckEvent, handleGetDailyTokens, handleGetHeartbeatStatus, handleIncrementDailyTokens } from "./handlers/heartbeat";
import { handleCreateJob, handleListJobs, handleTransitionJob } from "./handlers/jobs";
import { handleGetLearnedMemoryStatus, handleGetVectorizeMemoryStatus, handleSetLearnedMemoryStatus, handleSetVectorizeMemoryStatus } from "./handlers/memory-status";
import { handleListMessages, handleStoreMessage } from "./handlers/messages";
import { handleDeleteSecret, handleListSecrets, handleSaveSecret } from "./handlers/secrets";
import { handleGetHeartbeatSettings, handleGetVerbosity, handleSetHeartbeatSettings, handleSetVerbosity } from "./handlers/settings";

export type RouterCtx = {
  state: DurableObjectState;
  env: Env;
  data: BlobState;
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function routeRequest(
  url: URL,
  method: string,
  request: Request,
  ctx: RouterCtx,
): Promise<Response> {
  const { state, data, save } = ctx;
  const { pathname } = url;

  if (pathname === "/jobs" && method === "POST") {
    return handleCreateJob(request, ctx);
  }

  if (pathname === "/jobs/transition" && method === "POST") {
    return handleTransitionJob(request, ctx);
  }

  if (pathname === "/jobs" && method === "GET") {
    return handleListJobs(request, ctx);
  }

  if (pathname === "/state/migrate" && method === "POST") {
    const { channelMessages } = (await request.json()) as { channelMessages?: BlobState["messages"] };
    if (!data.migratedFromChannel && channelMessages?.length) {
      data.messages = [...channelMessages, ...data.messages];
      data.migratedFromChannel = true;
      await save();
    }
    return json({ migrated: data.migratedFromChannel === true });
  }

  if (pathname === "/repos" && method === "GET") {
    return json({ repos: data.repos });
  }

  if (pathname === "/repos" && method === "POST") {
    const { repo } = (await request.json()) as { repo: string };
    if (!data.repos.includes(repo)) {
      data.repos.push(repo);
      await save();
    }
    return json({ added: repo });
  }

  if (pathname === "/goals" && method === "GET") {
    const repo = url.searchParams.get("repo");
    if (!repo) return json({ error: "missing repo" }, 400);
    const goals = data.goals[repo] || ["improve codebase"];
    return json({ repo, goals });
  }

  if (pathname === "/goals" && method === "POST") {
    const { repo, goals } = (await request.json()) as { repo: string; goals: string[] };
    data.goals[repo] = goals;
    await save();
    return json({ saved: repo, goals });
  }

  if (pathname === "/messages" && method === "POST") {
    return handleStoreMessage(request, ctx);
  }

  if (pathname === "/messages" && method === "GET") {
    return handleListMessages(url, ctx);
  }

  if (pathname === "/settings/verbosity" && method === "GET") {
    return handleGetVerbosity(ctx);
  }

  if (pathname === "/settings/verbosity" && method === "POST") {
    return handleSetVerbosity(request, ctx);
  }

  if (pathname === "/settings/heartbeat" && method === "GET") {
    return handleGetHeartbeatSettings(ctx);
  }

  if (pathname === "/settings/heartbeat" && method === "POST") {
    return handleSetHeartbeatSettings(request, ctx);
  }

  if (pathname === "/memory/learned/status" && method === "GET") {
    return handleGetLearnedMemoryStatus(ctx);
  }

  if (pathname === "/memory/learned/status" && method === "POST") {
    return handleSetLearnedMemoryStatus(request, ctx);
  }

  if (pathname === "/memory/vectorize/status" && method === "GET") {
    return handleGetVectorizeMemoryStatus(ctx);
  }

  if (pathname === "/memory/vectorize/status" && method === "POST") {
    return handleSetVectorizeMemoryStatus(request, ctx);
  }

  if (pathname === "/heartbeat/status" && method === "GET") {
    return handleGetHeartbeatStatus({
      state,
      data,
      save,
      getEffectiveHeartbeatConfig: () => getEffectiveHeartbeatConfig(data, ctx.env),
    });
  }

  if (pathname === "/events/check" && method === "POST") {
    return handleCheckEvent(request, {
      state,
      data,
      save,
      getEffectiveHeartbeatConfig: () => getEffectiveHeartbeatConfig(data, ctx.env),
    });
  }

  if (pathname === "/cron" && method === "GET") {
    return handleListCronJobs(ctx);
  }

  if (pathname === "/cron" && method === "POST") {
    return handleCreateCronJob(request, ctx);
  }

  if (pathname === "/cron/outcome" && method === "POST") {
    return handleSaveCronOutcome(request, ctx);
  }

  if (pathname === "/cron/outcomes" && method === "GET") {
    return handleListCronOutcomes(ctx);
  }

  if (pathname === "/cron/delete" && method === "POST") {
    return handleDeleteCronJob(request, ctx);
  }

  if (pathname === "/daily-tokens" && method === "GET") {
    return handleGetDailyTokens(url, {
      state,
      data,
      save,
      getEffectiveHeartbeatConfig: () => getEffectiveHeartbeatConfig(data, ctx.env),
    });
  }

  if (pathname === "/daily-tokens" && method === "POST") {
    return handleIncrementDailyTokens(request, {
      state,
      data,
      save,
      getEffectiveHeartbeatConfig: () => getEffectiveHeartbeatConfig(data, ctx.env),
    });
  }

  if (pathname === "/secrets" && method === "GET") {
    return handleListSecrets(ctx);
  }

  if (pathname === "/secrets" && method === "POST") {
    return handleSaveSecret(request, ctx);
  }

  if (pathname === "/secrets/values" && method === "GET") {
    const rows = state.storage.sql.exec("SELECT name, value FROM service_secrets ORDER BY name ASC");
    const secrets: Record<string, string> = {};
    for (const row of rows) {
      secrets[String(row.name)] = String(row.value);
    }
    return json({ secrets });
  }

  if (pathname === "/secrets/delete" && method === "POST") {
    return handleDeleteSecret(request, ctx);
  }

  return new Response("Not found", { status: 404 });
}
