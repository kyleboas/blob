import { mapChannelToDO, parseSlackEvent, verifySlackSignature } from "./slack";
import { classifyMessage } from "./llm";
import type { Env, SlackEvent } from "./types";

export { AgentDO } from "./agent";

const GLOBAL_LOGS_CHANNEL = "__global__";
const HEARTBEAT_DO_NAME = "blob:heartbeats";

interface DiagCheckResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

async function runDiagCheck(name: string, fn: () => Promise<void>): Promise<DiagCheckResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - start };
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : "unknown error"
    };
  }
}

async function runDiagnostics(env: Env, traceId: string): Promise<{ trace_id: string; ok: boolean; checks: DiagCheckResult[] }> {
  const checks: DiagCheckResult[] = [];

  checks.push(await runDiagCheck("worker_health", async () => {
    if (!env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN missing");
  }));

  checks.push(await runDiagCheck("do_round_trip", async () => {
    const response = await forwardToHeartbeatDO(env, { action: "logs_snapshot", trace_id: traceId });
    if (!response.ok) throw new Error(`DO returned ${response.status}`);
  }));

  checks.push(await runDiagCheck("sandbox_exec", async () => {
    if (!env.SANDBOX) throw new Error("SANDBOX binding missing");
    const sandbox = env.SANDBOX as unknown as { exec: (command: string) => Promise<{ stdout?: string; stderr?: string; exitCode?: number }> };
    const result = await sandbox.exec("echo ok");
    if ((result.exitCode ?? 1) !== 0) throw new Error(result.stderr ?? "sandbox command failed");
  }));

  checks.push(await runDiagCheck("llm_config", async () => {
    const classification = await classifyMessage({
      systemPrompt: "diag",
      messages: [{ role: "user", content: "ping" }],
      routerModel: "openai/gpt-4.1-mini",
      apiKey: env.ANTHROPIC_API_KEY,
      openAiApiKey: env.OPENAI_API_KEY,
      aiGatewayBaseUrl: env.AI_GATEWAY_BASE_URL,
      aiGatewayToken: env.AI_GATEWAY_TOKEN
    });
    if (!["chat", "routine", "complex"].includes(classification)) {
      throw new Error("Unexpected LLM classification result");
    }
  }));

  checks.push(await runDiagCheck("github_auth", async () => {
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN missing");
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  }));

  return {
    trace_id: traceId,
    ok: checks.every((check) => check.ok),
    checks
  };
}

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
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; background: #0f172a; color: #e2e8f0; }
    h1 { margin-top: 0; font-size: 1.2rem; display: flex; align-items: center; gap: 0.5rem; }
    #live-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ade80; display: inline-block; animation: pulse 2s ease-in-out infinite; }
    #live-dot.error { background: #f87171; animation: none; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    #status { color: #94a3b8; margin-bottom: 0.5rem; font-size: 0.85rem; }
    #status.error { color: #f87171; }
    #tabs { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; flex-wrap: wrap; align-items: center; }
    .tab { font-family: inherit; font-size: 0.8rem; background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 4px; padding: 0.2rem 0.6rem; cursor: pointer; }
    .tab:hover { background: #334155; color: #e2e8f0; }
    .tab.active { background: #1d4ed8; color: #e2e8f0; border-color: #3b82f6; }
    .tab-sep { color: #334155; font-size: 0.8rem; padding: 0 0.1rem; }
    .tab.model-tab { border-color: #4ade8066; color: #86efac; }
    .tab.model-tab:hover { border-color: #4ade80; }
    .tab.model-tab.active { background: #14532d; border-color: #4ade80; color: #4ade80; }
    #log { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #020617; border: 1px solid #1e293b; border-radius: 8px; padding: 1rem; min-height: 300px; max-height: calc(100vh - 140px); overflow-y: auto; margin: 0; user-select: text; cursor: text; }
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
    .line-model_used { color: #86efac; }
    .empty { color: #475569; font-style: italic; }
    #copy-btn { margin-left: auto; font-family: inherit; font-size: 0.8rem; background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 4px; padding: 0.25rem 0.6rem; cursor: pointer; }
    #copy-btn:hover { background: #334155; color: #e2e8f0; }
    #copy-btn.copied { color: #4ade80; border-color: #4ade80; }
    .build-group { display: block; }
    .build-group + .build-group { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid #1e293b; }
    .build-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; white-space: normal; cursor: pointer; user-select: none; }
    .build-header:hover .build-label { color: #94a3b8; }
    .build-chevron { color: #475569; font-size: 0.7rem; flex-shrink: 0; transition: transform 0.15s ease; display: inline-block; }
    .build-group.collapsed .build-chevron { transform: rotate(-90deg); }
    .build-label { color: #fff; font-size: 0.8rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .build-body { display: block; }
    .build-group.collapsed .build-body { display: none; }
    .build-copy-btn { font-family: inherit; font-size: 0.75rem; background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 4px; padding: 0.15rem 0.5rem; cursor: pointer; flex-shrink: 0; }
    .build-copy-btn:hover { background: #334155; color: #e2e8f0; }
    .build-copy-btn.copied { color: #4ade80; border-color: #4ade80; }
  </style>
</head>
<body>
  <h1><span id="live-dot"></span>Blob Live Logs<button id="copy-btn" title="Copy all log text">Copy all</button></h1>
  <div id="tabs">
    <button class="tab active" data-tab="all">All</button>
    <button class="tab" data-tab="tasks">Tasks</button>
    <button class="tab" data-tab="heartbeats">Heartbeats</button>
    <span class="tab-sep">|</span>
  </div>
  <div id="status">Connecting...</div>
  <div id="log"><span class="empty">Waiting for events...</span></div>
  <script>
    const logNode = document.getElementById('log');
    const statusNode = document.getElementById('status');
    const dotNode = document.getElementById('live-dot');
    const tabsNode = document.getElementById('tabs');
    const copyBtn = document.getElementById('copy-btn');
    let lastSnapshotSig = '';
    let currentEvents = [];
    let activeTab = 'all';
    const userCollapsedState = new Map();

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

    // Tab click handlers for static tabs
    tabsNode.querySelectorAll('.tab[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.getAttribute('data-tab')));
    });

    function setTab(tab) {
      activeTab = tab;
      tabsNode.querySelectorAll('.tab').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
      });
      const builds = computeBuilds(currentEvents);
      renderBuilds(builds);
    }

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function formatLine(event) {
      const when = new Date(event.createdAt * 1000).toISOString().replace('T', ' ').replace('Z', '');
      const cls = 'line-' + event.eventType;
      const text = when + '  [' + event.eventType + ']  ' + event.message;
      return '<span class="' + cls + '">' + escHtml(text) + '</span>';
    }

    // Extract model name from a model_used event message (strips [#channel] prefix)
    function extractModel(message) {
      return message.replace(/^\\[#[^\\]]+\\]\\s*/, '').trim();
    }

    // Short display name for a model (strips provider prefix, truncates)
    function shortModel(model) {
      return model.replace(/^(anthropic\\/|openai\\/)/, '').slice(0, 32);
    }

    function computeBuilds(events) {
      const builds = [];
      let currentBuild = null;
      
      for (const event of events) {
        // Start a new build when we see a user message or task start
        if (event.eventType === 'task_received' || 
            event.eventType === 'message_received' || 
            event.eventType === 'heartbeat_start') {
          // Save previous build if exists
          if (currentBuild) {
            builds.push(currentBuild);
          }
          // Start new build
          currentBuild = {
            label: event.message.slice(0, 120),
            type: event.eventType === 'heartbeat_start' ? 'heartbeat' : 'task',
            model: null,
            events: [event],
            key: event.createdAt + '-' + event.eventType
          };
        } else if (currentBuild) {
          // Add event to current build
          currentBuild.events.push(event);
          // Track model used
          if (event.eventType === 'model_used' && !currentBuild.model) {
            currentBuild.model = extractModel(event.message);
          }
        } else {
          // Orphaned event (no parent) - create a small build
          builds.push({
            label: event.eventType + ': ' + event.message.slice(0, 60),
            type: 'other',
            model: null,
            events: [event],
            key: event.createdAt + '-' + event.eventType
          });
        }
      }
      
      // Don't forget the last build
      if (currentBuild) {
        builds.push(currentBuild);
      }
      
      return builds;
    }

    function updateModelTabs(builds) {
      // Collect unique models in order of first appearance
      const seen = new Set();
      const models = [];
      for (const b of builds) {
        if (b.model && !seen.has(b.model)) { seen.add(b.model); models.push(b.model); }
      }
      // Remove stale model tabs
      tabsNode.querySelectorAll('.model-tab').forEach((t) => t.remove());
      // Re-add model tabs after the separator
      for (const model of models) {
        const btn = document.createElement('button');
        btn.className = 'tab model-tab' + (activeTab === model ? ' active' : '');
        btn.setAttribute('data-tab', model);
        btn.textContent = shortModel(model);
        btn.title = model;
        btn.addEventListener('click', () => setTab(model));
        tabsNode.appendChild(btn);
      }
    }

    function filterBuilds(builds) {
      if (activeTab === 'all') return builds;
      if (activeTab === 'tasks') return builds.filter((b) => b.type === 'task');
      if (activeTab === 'heartbeats') return builds.filter((b) => b.type === 'heartbeat');
      // model tab
      return builds.filter((b) => b.model === activeTab);
    }

    function renderBuilds(builds) {
      const filtered = filterBuilds(builds);
      if (filtered.length === 0) {
        logNode.innerHTML = '<span class="empty">No events for this filter yet.</span>';
        return;
      }

      const atBottom = logNode.scrollHeight - logNode.scrollTop <= logNode.clientHeight + 50;

      // Reverse to show newest first
      const reversed = [...filtered].reverse();

      logNode.innerHTML = reversed.map((build, idx) => {
        const labelHtml = build.label !== null ? escHtml(build.label) : 'Event';
        const isLast = idx === filtered.length - 1;
        const key = build.key;
        const defaultCollapsed = !isLast;
        const isCollapsed = userCollapsedState.has(key) ? userCollapsedState.get(key) : defaultCollapsed;
        const collapsedClass = isCollapsed ? ' collapsed' : '';
        const modelBadge = build.model ? ' <span style="color:#86efac;font-size:0.75rem">' + escHtml(shortModel(build.model)) + '</span>' : '';
        const header = '<div class="build-header"><span class="build-chevron">&#9660;</span><span class="build-label">' + labelHtml + modelBadge + '</span><button class="build-copy-btn" data-idx="' + idx + '">Copy</button></div>';
        const lines = build.events.map(formatLine).join('\\n');
        return '<div class="build-group' + collapsedClass + '" data-key="' + escHtml(key) + '">' + header + '<div class="build-body">' + lines + '</div></div>';
      }).join('');

      // Attach collapse toggle handlers
      logNode.querySelectorAll('.build-header').forEach((header) => {
        header.addEventListener('click', (e) => {
          if (e.target.classList.contains('build-copy-btn')) return;
          const group = header.closest('.build-group');
          if (group) {
            group.classList.toggle('collapsed');
            const key = group.getAttribute('data-key') || '';
            userCollapsedState.set(key, group.classList.contains('collapsed'));
          }
        });
      });

      // Attach per-build copy button handlers
      logNode.querySelectorAll('.build-copy-btn').forEach((btn, btnIdx) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const build = reversed[btnIdx];
          const text = build.events.map((event) => {
            const when = new Date(event.createdAt * 1000).toISOString().replace('T', ' ').replace('Z', '');
            return when + '  [' + event.eventType + ']  ' + event.message;
          }).join('\n');
          navigator.clipboard.writeText(text).then(() => {
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
          }).catch(() => {});
        });
      });

      if (atBottom) logNode.scrollTop = logNode.scrollHeight;
    }

    function renderEvents(events) {
      currentEvents = events;
      const builds = computeBuilds(events);
      updateModelTabs(builds);
      renderBuilds(builds);
      if (events.length === 0) {
        logNode.innerHTML = '<span class="empty">No events yet. Blob activity will appear here automatically.</span>';
      }
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

    let source;
    let reconnectTimer;
    let lastLiveEventAt = Date.now();

    function scheduleReconnect(reason) {
      if (reconnectTimer) return;
      statusNode.textContent = 'Live stream disconnected (' + reason + ') • reconnecting...';
      statusNode.className = 'error';
      dotNode.className = 'error';
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connectLiveStream();
      }, 1000);
    }

    function connectLiveStream() {
      if (source) source.close();
      source = new EventSource('/logs/stream');
      source.addEventListener('snapshot', (event) => {
        lastLiveEventAt = Date.now();
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
        scheduleReconnect('network issue');
      };
    }

    refreshLogs();
    connectLiveStream();

    setInterval(() => {
      const staleMs = Date.now() - lastLiveEventAt;
      if (staleMs > 10000) {
        scheduleReconnect('stale stream');
      }
    }, 5000);

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

    if (request.method === "POST" && url.pathname === "/diag/run") {
      const authHeader = request.headers.get("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!env.DIAG_TOKEN || !token || token !== env.DIAG_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      const traceId = crypto.randomUUID();
      const payload = await runDiagnostics(env, traceId);
      return Response.json(payload, { status: payload.ok ? 200 : 500 });
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

    // Deploy hook - trigger heartbeats on all active channels after deployment
    if (request.method === "POST" && url.pathname === "/deploy") {
      const authHeader = request.headers.get("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      if (!env.DIAG_TOKEN || !token || token !== env.DIAG_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }

      // Trigger heartbeat alarm on the global heartbeat DO
      const response = await forwardToHeartbeatDO(env, { 
        action: "deploy_trigger",
        timestamp: new Date().toISOString()
      });
      
      return Response.json({ 
        status: "triggered", 
        message: "Heartbeat alarms scheduled on all active channels"
      }, { status: 200 });
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
