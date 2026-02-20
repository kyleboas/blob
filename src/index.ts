import { mapThreadToDO, parseSlackEvent, verifySlackSignature } from "./slack";
import type { Env, SlackEvent } from "./types";

export { AgentDO } from "./agent";

async function forwardToAgent(env: Env, threadTs: string, payload: { action: "message" | "reaction"; event: SlackEvent }): Promise<void> {
  const id = env.AGENT_DO.idFromName(mapThreadToDO(threadTs));
  const stub = env.AGENT_DO.get(id);

  const response = await stub.fetch("https://agent.internal/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Agent Durable Object request failed with status ${response.status}`);
  }
}

function renderLiveLogPage(threadTs: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Blob Live Logs</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1rem; background: #0f172a; color: #e2e8f0; }
    h1 { margin-top: 0; font-size: 1.2rem; }
    #status { color: #93c5fd; margin-bottom: 1rem; }
    pre { white-space: pre-wrap; background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 1rem; min-height: 300px; }
  </style>
</head>
<body>
  <h1>Blob Live Logs</h1>
  <div id="status">Thread: ${threadTs}</div>
  <pre id="log">Waiting for events...</pre>
  <script>
    const threadTs = ${JSON.stringify(threadTs)};
    const logNode = document.getElementById('log');
    const statusNode = document.getElementById('status');

    async function refreshLogs() {
      const response = await fetch('/live-logs/data?thread_ts=' + encodeURIComponent(threadTs), { cache: 'no-store' });
      if (!response.ok) {
        statusNode.textContent = 'Failed to load logs: ' + response.status;
        return;
      }

      const payload = await response.json();
      const lines = payload.events.map((event) => {
        const when = new Date(event.createdAt * 1000).toISOString();
        return '[' + when + '] [' + event.eventType + '] ' + event.message;
      });
      logNode.textContent = lines.length ? lines.join('\n') : 'No events yet.';
      statusNode.textContent = 'Thread: ' + threadTs + ' • Last updated: ' + new Date().toLocaleTimeString();
      logNode.scrollTop = logNode.scrollHeight;
    }

    refreshLogs();
    setInterval(refreshLogs, 2000);
  </script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "GET" && url.pathname === "/live-logs") {
      const threadTs = url.searchParams.get("thread_ts") ?? "";
      if (!threadTs) {
        return new Response("Missing query parameter: thread_ts", { status: 400 });
      }

      return new Response(renderLiveLogPage(threadTs), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (request.method === "GET" && url.pathname === "/live-logs/data") {
      const threadTs = url.searchParams.get("thread_ts") ?? "";
      if (!threadTs) {
        return Response.json({ error: "missing thread_ts" }, { status: 400 });
      }

      const id = env.AGENT_DO.idFromName(mapThreadToDO(threadTs));
      const stub = env.AGENT_DO.get(id);
      const response = await stub.fetch("https://agent.internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "logs_snapshot", event: { thread_ts: threadTs } })
      });

      if (!response.ok) {
        return Response.json({ error: "failed to read logs" }, { status: 500 });
      }

      const payload = await response.text();
      return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    }

    if (request.method !== "POST" || url.pathname !== "/slack/events") {
      return new Response("not found", { status: 404 });
    }

    const verified = await verifySlackSignature(request, env.SLACK_SIGNING_SECRET);
    if (!verified) {
      return new Response("invalid signature", { status: 401 });
    }

    const body = await request.text();
    let envelope;
    try {
      envelope = parseSlackEvent(body);
    } catch {
      return new Response("bad request", { status: 400 });
    }

    if (envelope.type === "url_verification") {
      return Response.json({ challenge: envelope.challenge ?? "" });
    }

    const event = envelope.event;
    if (!event) {
      return new Response("ok", { status: 200 });
    }

    if (event.type === "message") {
      // Skip bot messages (including own responses) and message subtypes
      // (edited/deleted messages) to prevent infinite loops and noise
      if (!event.subtype && !event.bot_id) {
        const threadTs = event.thread_ts ?? event.ts;
        if (threadTs) {
          ctx.waitUntil(forwardToAgent(env, threadTs, { action: "message", event }));
        }
      }
      return new Response("ok", { status: 200 });
    }

    if (event.type === "reaction_added") {
      const threadTs = event.thread_ts ?? event.ts;
      if (threadTs) {
        ctx.waitUntil(forwardToAgent(env, threadTs, { action: "reaction", event }));
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("ok", { status: 200 });
  }
};
