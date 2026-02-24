import { mapChannelToDO, parseSlackEvent, verifySlackSignature } from "./slack";
import type { Env, SlackEvent } from "./types";

export { AgentDO } from "./agent";

const GLOBAL_LOGS_CHANNEL = "__global__";
const HEARTBEAT_DO_NAME = "blob:heartbeats";

async function forwardToHeartbeatDO(
  env: Env,
  payload: Record<string, unknown>
): Promise<Response> {
  const id = env.AGENT_DO.idFromName(HEARTBEAT_DO_NAME);
  const stub = env.AGENT_DO.get(id);
  return stub.fetch("https://agent.internal/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

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

function renderLiveLogPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Blob Live Logs</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1rem; background: #0f172a; color: #e2e8f0; }
    h1 { margin-top: 0; font-size: 1.2rem; display: flex; align-items: center; gap: 0.5rem; }
    #live-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; display: inline-block; animation: pulse 2s ease-in-out infinite; }
    #live-dot.error { background: #f87171; animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    #status { color: #94a3b8; margin-bottom: 0.75rem; font-size: 0.85rem; }
    #status.error { color: #f87171; }
    #log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 1rem; min-height: 300px; max-height: calc(100vh - 120px); overflow-y: auto; margin: 0; user-select: text; cursor: text; }
    #log span { user-select: text; }
    .line-task_received { color: #60a5fa; }
    .line-command { color: #e2e8f0; }
    .line-command_success { color: #4ade80; }
    .line-command_failure { color: #f87171; }
    .line-command_output { color: #93c5fd; }
    .line-command_error { color: #fca5a5; }
    .line-completed { color: #a78bfa; }
    .line-message { color: #fbbf24; }
    .line-thinking, .line-session, .line-trace { color: #94a3b8; }
    .line-trace_warning { color: #f59e0b; }
    .line-trace_error, .line-background_error { color: #f87171; }
    .line-heartbeat_start { color: #22d3ee; }
    .empty { color: #475569; font-style: italic; }
    #copy-btn { margin-left: auto; font-family: inherit; font-size: 0.8rem; background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 4px; padding: 0.25rem 0.6rem; cursor: pointer; }
    #copy-btn:hover { background: #334155; color: #e2e8f0; }
    #copy-btn.copied { color: #4ade80; border-color: #4ade80; }
    .build-group { display: block; }
    .build-group + .build-group { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #1e293b; }
    .build-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; white-space: normal; }
    .build-label { color: #64748b; font-size: 0.8rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .build-copy-btn { font-family: inherit; font-size: 0.75rem; background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 4px; padding: 0.15rem 0.5rem; cursor: pointer; flex-shrink: 0; }
    .build-copy-btn:hover { background: #334155; color: #e2e8f0; }
    .build-copy-btn.copied { color: #4ade80; border-color: #4ade80; }
  </style>
</head>
<body>
  <h1><span id="live-dot"></span>Blob Live Logs<button id="copy-btn" title="Copy all log text">Copy all</button></h1>
  <div id="status">Connecting...</div>
  <div id="log"><span class="empty">Waiting for events...</span></div>
  <script>
    const logNode = document.getElementById('log');
    const statusNode = document.getElementById('status');
    const dotNode = document.getElementById('live-dot');
    const copyBtn = document.getElementById('copy-btn');
    let lastSnapshotSig = '';
    let currentEvents = [];

    copyBtn.addEventListener('click', () => {
      const text = currentEvents.map((event) => {
        const when = new Date(event.createdAt * 1000).toISOString().replace('T', ' ').replace('Z', '');
        return when + '  [' + event.eventType + ']  ' + event.message;
      }).join('\\n');
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        copyBtn.className = 'copied';
        setTimeout(() => { copyBtn.textContent = 'Copy all'; copyBtn.className = ''; }, 2000);
      }).catch(() => {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(logNode);
        sel.removeAllRanges();
        sel.addRange(range);
      });
    });

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function formatLine(event) {
      const when = new Date(event.createdAt * 1000).toISOString().replace('T', ' ').replace('Z', '');
      const cls = 'line-' + event.eventType;
      const text = when + '  [' + event.eventType + ']  ' + event.message;
      return '<span class="' + cls + '">' + escHtml(text) + '</span>';
    }

    function renderEvents(events) {
      currentEvents = events;
      if (events.length === 0) {
        logNode.innerHTML = '<span class="empty">No events yet. Blob activity will appear here automatically.</span>';
        return;
      }

      const atBottom = logNode.scrollHeight - logNode.scrollTop <= logNode.clientHeight + 50;

      // Group events into builds; a new build starts at each task_received or heartbeat_start event
      const builds = [];
      let current = null;
      for (const event of events) {
        if (event.eventType === 'task_received' || event.eventType === 'heartbeat_start') {
          current = { label: event.message, events: [] };
          builds.push(current);
        }
        if (!current) {
          current = { label: null, events: [] };
          builds.push(current);
        }
        current.events.push(event);
      }

      logNode.innerHTML = builds.map((build, idx) => {
        const labelHtml = build.label !== null ? escHtml(build.label.slice(0, 120)) : 'Events';
        const header = '<div class="build-header"><span class="build-label">' + labelHtml + '</span><button class="build-copy-btn" data-idx="' + idx + '">Copy</button></div>';
        const lines = build.events.map(formatLine).join('\\n');
        return '<div class="build-group">' + header + lines + '</div>';
      }).join('');

      // Attach per-build copy button handlers
      logNode.querySelectorAll('.build-copy-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.getAttribute('data-idx'));
          const build = builds[idx];
          const text = build.events.map((event) => {
            const when = new Date(event.createdAt * 1000).toISOString().replace('T', ' ').replace('Z', '');
            return when + '  [' + event.eventType + ']  ' + event.message;
          }).join('\\n');
          navigator.clipboard.writeText(text).then(() => {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
          }).catch(() => {});
        });
      });

      if (atBottom) logNode.scrollTop = logNode.scrollHeight;
    }

    async function refreshLogs() {
      let payload;
      try {
        const response = await fetch('/logs/data', { cache: 'no-store' });
        if (!response.ok) {
          statusNode.textContent = 'Error: HTTP ' + response.status;
          statusNode.className = 'error';
          dotNode.className = 'error';
          return;
        }
        payload = await response.json();
      } catch (e) {
        statusNode.textContent = 'Error: ' + (e.message || 'fetch failed');
        statusNode.className = 'error';
        dotNode.className = 'error';
        return;
      }

      dotNode.className = '';
      statusNode.className = '';

      const events = payload.events || [];
      statusNode.textContent = 'Live across all channels • ' + events.length + ' event' + (events.length === 1 ? '' : 's') + ' • updated ' + new Date().toLocaleTimeString();

      const snapshotSig = JSON.stringify(events.map((event) => [event.createdAt, event.eventType, event.message]));
      if (snapshotSig === lastSnapshotSig) return;
      lastSnapshotSig = snapshotSig;
      renderEvents(events);
    }

    refreshLogs();
    const source = new EventSource('/logs/stream');
    source.addEventListener('snapshot', (event) => {
      try {
        const payload = JSON.parse(event.data || '{}');
        const events = payload.events || [];
        statusNode.textContent = 'Live across all channels • ' + events.length + ' event' + (events.length === 1 ? '' : 's') + ' • updated ' + new Date().toLocaleTimeString();
        statusNode.className = '';
        dotNode.className = '';
        lastSnapshotSig = JSON.stringify(events.map((item) => [item.createdAt, item.eventType, item.message]));
        renderEvents(events);
      } catch {
        statusNode.textContent = 'Error: failed to parse live stream event';
        statusNode.className = 'error';
        dotNode.className = 'error';
      }
    });
    source.onerror = () => {
      statusNode.textContent = 'Live stream interrupted; retrying...';
      statusNode.className = 'error';
      dotNode.className = 'error';
    };

    setInterval(refreshLogs, 10000);
  </script>
</body>
</html>`;
}

async function fetchGlobalLogsSnapshot(env: Env): Promise<Response> {
  const id = env.AGENT_DO.idFromName(mapChannelToDO(GLOBAL_LOGS_CHANNEL));
  const stub = env.AGENT_DO.get(id);
  const response = await stub.fetch("https://agent.internal/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "logs_snapshot" })
  });

  if (!response.ok) {
    throw new Error("failed to read logs");
  }

  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/logs" || url.pathname === "/live-logs")) {
      return new Response(renderLiveLogPage(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    if (request.method === "GET" && (url.pathname === "/logs/data" || url.pathname === "/live-logs/data")) {
      let response: Response;
      try {
        response = await fetchGlobalLogsSnapshot(env);
      } catch {
        return Response.json({ error: "failed to read logs" }, { status: 500 });
      }

      const payload = await response.text();
      return new Response(payload, { status: 200, headers: { "content-type": "application/json" } });
    }

    if (request.method === "GET" && (url.pathname === "/logs/stream" || url.pathname === "/live-logs/stream")) {
      let closed = false;
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(": connected\n\n"));

          while (!closed) {
            try {
              const response = await fetchGlobalLogsSnapshot(env);
              const payload = await response.text();
              controller.enqueue(encoder.encode(`event: snapshot\ndata: ${payload}\n\n`));
            } catch {
              controller.enqueue(encoder.encode("event: error\ndata: {\"error\":\"failed to read logs\"}\n\n"));
            }

            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        },
        cancel() {
          closed = true;
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        }
      });
    }

    // Heartbeat API – enqueue background tasks for Blob to work on proactively
    if (request.method === "POST" && url.pathname === "/heartbeats") {
      const body = await request.json() as { task?: string; channel?: string };
      if (!body.task || !body.channel) {
        return Response.json({ error: "task and channel are required" }, { status: 400 });
      }
      const response = await forwardToHeartbeatDO(env, {
        action: "enqueue_heartbeat",
        task: body.task,
        channel: body.channel
      });
      return response;
    }

    if (request.method === "GET" && url.pathname === "/heartbeats") {
      const response = await forwardToHeartbeatDO(env, { action: "list_heartbeats" });
      return response;
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
