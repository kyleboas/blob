import { withDOAuth } from "../core/do-auth";
import type { Env } from "../core/types";

const APPROVAL_TTL_MS = 30 * 60 * 1000;

function approvalDo(env: Env): DurableObjectStub {
  return env.AGENT_DO.get(env.AGENT_DO.idFromName("blob"));
}

function buildRequestId(): string {
  return `deploy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function summarizeDiff(diff: string): string {
  if (diff.length <= 3000) return diff;
  return `${diff.slice(0, 3000)}\n\n…(diff truncated)`;
}

async function loadApprovers(env: Env): Promise<Set<string>> {
  try {
    const obj = await env.REPO_STORE.get("config/deploy-approvers.json");
    if (!obj) return new Set();
    const data = await obj.json<{ allowedUserIds?: string[] }>();
    return new Set(data.allowedUserIds ?? []);
  } catch (err) {
    console.error("loadApprovers failed", err);
    return new Set();
  }
}

export async function requestApproval(diff: string, channel: string, env: Env): Promise<string> {
  const requestId = buildRequestId();
  await approvalDo(env).fetch("http://do/deploy/approval", withDOAuth(env, {
    method: "POST",
    body: JSON.stringify({ action: "request", requestId, diff, requestedAt: Date.now() }),
  }));

  if (env.SLACK_BOT_TOKEN) {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text: `🚦 Deploy approval requested (${requestId}). Reply with \"approve ${requestId}\" or \"reject ${requestId}\".\n\n\
${summarizeDiff(diff)}`,
      }),
    });
  }

  return requestId;
}

export async function checkApproval(requestId: string, env: Env): Promise<"pending" | "approved" | "rejected" | "expired"> {
  const res = await approvalDo(env).fetch(`http://do/deploy/approval?requestId=${encodeURIComponent(requestId)}`, withDOAuth(env));
  if (!res.ok) return "expired";
  const data = await res.json() as { status?: "pending" | "approved" | "rejected" | "expired"; requestedAt?: number };
  const status = data.status ?? "expired";
  if (status !== "pending") return status;
  if (typeof data.requestedAt === "number" && Date.now() - data.requestedAt > APPROVAL_TTL_MS) return "expired";
  return "pending";
}

export async function processApprovalMessage(text: string, userId: string, env: Env): Promise<boolean> {
  const normalized = text.trim().toLowerCase();
  const match = normalized.match(/^(approve|reject)\s+([a-z0-9-]+)/i);
  if (!match) return false;

  const approvers = await loadApprovers(env);
  if (!approvers.has(userId)) return false;

  const action = match[1] === "approve" ? "approved" : "rejected";
  const requestId = match[2];
  const res = await approvalDo(env).fetch("http://do/deploy/approval", withDOAuth(env, {
    method: "POST",
    body: JSON.stringify({ action: "decision", requestId, status: action, approvedBy: userId }),
  }));

  return res.ok;
}
