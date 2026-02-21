import { mapChannelToDO, parseSlackEvent, verifySlackSignature } from "./slack";
import type { Env, SlackEvent } from "./types";

export { AgentDO } from "./agent";

const GLOBAL_LOGS_CHANNEL = "__global__";

async function forwardToAgent(env: Env, channel: string, payload: { action: "message" | "reaction" | "logs_mirror"; event: SlackEvent }): Promise<void> {
  const id = env.AGENT_DO.idFromName(mapChannelToDO(channel));
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

function renderLiveLogPage(defaultChannel: string): string {
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
    .channel-picker { margin-bottom: 1rem; }
    .channel-picker input { background: #020617; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 0.4rem 0.5rem; min-width: 220px; }
    .channel-picker button { margin-left: 0.5rem; background: #1d4ed8; color: #fff; border: none; border-radius: 6px; padding: 0.45rem 0.75rem; cursor: pointer; }
    pre { white-space: pre-wrap; background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 1rem; min-height: 300px; }
  </style>
</head>
<body>
  <h1>Blob Live Logs</h1>
  <div class="channel-picker">
    <label for="channel-input">Channel:</label>
    <input id="channel-input" name="channel" placeholder="e.g. C123456" />
    <button id="channel-apply" type="button">Apply</button>
  </div>
  <div id="status">Loading logs...</div>
  <pre id="log">Waiting for events...</pre>
  <script>
    const defaultChannel = ${JSON.stringify(defaultChannel)};
    const logNode = document.getElementById('log');
    const statusNode = document.getElementById('status');
    const input = document.getElementById('channel-input');
    const applyButton = document.getElementById('channel-apply');

    const params = new URLSearchParams(window.location.search);
    function safeReadChannel() {
      try {
        return localStorage.getItem('blob_logs_channel') || '';
      } catch {
        return '';
      }
    }

    function safeWriteChannel(value) {
      try {
        if (value) {
          localStorage.setItem('blob_logs_channel', value);
        } else {
          localStorage.removeItem('blob_logs_channel');
        }
      } catch {
        // Local storage can fail in private browsing or restricted contexts.
      }
    }

    let channel = (params.get('channel') || defaultChannel || safeReadChannel() || '').trim();
    input.value = channel;

    function persistChannel(nextChannel) {
      channel = nextChannel.trim();
      input.value = channel;
      if (channel) {
        safeWriteChannel(channel);
        params.set('channel', channel);
      } else {
        safeWriteChannel('');
        params.delete('channel');
      }
      const query = params.toString();
      history.replaceState({}, '', query ? ('?' + query) : window.location.pathname);
    }

    async function refreshLogs() {
      const query = channel ? ('?channel=' + encodeURIComponent(channel)) : '';
      const response = await fetch('/logs/data' + query, { cache: 'no-store' });
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
      const channelLabel = channel && channel !== ${JSON.stringify(GLOBAL_LOGS_CHANNEL)}
        ? channel
        : 'all channels';
      statusNode.textContent = 'Channel: ' + channelLabel + ' • Last updated: ' + new Date().toLocaleTimeString();
      logNode.scrollTop = logNode.scrollHeight;
    }

    applyButton.addEventListener('click', () => {
      persistChannel(input.value);
      refreshLogs();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        persistChannel(input.value);
        refreshLogs();
      }
    });

    refreshLogs();
    setInterval(refreshLogs, 2000);
  </script>
</body>
</html>`;
}

function resolveLogChannel(url: URL, env: Env): string {
  return (url.searchParams.get("channel") ?? env.LOGS_CHANNEL ?? GLOBAL_LOGS_CHANNEL).trim();
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "GET" && (url.pathname === "/logs" || url.pathname === "/live-logs")) {
      return new Response(renderLiveLogPage(resolveLogChannel(url, env)), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (request.method === "GET" && (url.pathname === "/logs/data" || url.pathname === "/live-logs/data")) {
      const channel = resolveLogChannel(url, env);

      const id = env.AGENT_DO.idFromName(mapChannelToDO(channel));
      const stub = env.AGENT_DO.get(id);
      const response = await stub.fetch("https://agent.internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "logs_snapshot" })
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
        const channel = event.channel;
        if (channel) {
          ctx.waitUntil(forwardToAgent(env, channel, { action: "message", event }));
          ctx.waitUntil(forwardToAgent(env, GLOBAL_LOGS_CHANNEL, { action: "logs_mirror", event }));
        }
      }
      return new Response("ok", { status: 200 });
    }

    if (event.type === "reaction_added") {
      const channel = event.item?.channel ?? event.channel;
      if (channel) {
        ctx.waitUntil(forwardToAgent(env, channel, { action: "reaction", event }));
        ctx.waitUntil(forwardToAgent(env, GLOBAL_LOGS_CHANNEL, { action: "logs_mirror", event }));
      }
      return new Response("ok", { status: 200 });
    }

    return new Response("ok", { status: 200 });
  }
};
