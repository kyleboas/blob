import type { SlackEvent } from "./types";

const SLACK_API_BASE = "https://slack.com/api";
const SIGNATURE_VERSION = "v0";
const MAX_REQUEST_AGE_SECONDS = 60 * 5;

export interface ParsedSlackEnvelope {
  type: "url_verification" | "event_callback";
  challenge?: string;
  event?: SlackEvent;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signSlackBaseString(baseString: string, signingSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  return `${SIGNATURE_VERSION}=${toHex(signature)}`;
}

export async function verifySlackSignature(request: Request, signingSecret: string): Promise<boolean> {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const slackSignature = request.headers.get("x-slack-signature");

  if (!timestamp || !slackSignature) {
    return false;
  }

  const requestAge = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(requestAge) || requestAge > MAX_REQUEST_AGE_SECONDS) {
    return false;
  }

  const body = await request.clone().text();
  const baseString = `${SIGNATURE_VERSION}:${timestamp}:${body}`;
  const expectedSignature = await signSlackBaseString(baseString, signingSecret);

  return slackSignature === expectedSignature;
}

export function parseSlackEvent(body: string): ParsedSlackEnvelope {
  const payload = JSON.parse(body) as {
    type?: string;
    challenge?: string;
    event?: SlackEvent;
  };

  if (payload.type === "url_verification") {
    return {
      type: "url_verification",
      challenge: payload.challenge ?? ""
    };
  }

  if (payload.type === "event_callback" && payload.event) {
    const event = payload.event;

    if (event.type === "message") {
      // Ignore bot messages (including our own replies) and message edit/delete subtypes
      if (event.bot_id || event.subtype) {
        return { type: "event_callback" };
      }
      return { type: "event_callback", event };
    }

    if (event.type === "reaction_added") {
      return { type: "event_callback", event };
    }

    // Unknown event type — acknowledge without processing
    return { type: "event_callback" };
  }

  // Unknown top-level payload type — acknowledge without processing
  return { type: "event_callback" };
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {})
    })
  });

  const bodyJson = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok || !bodyJson.ok) {
    throw new Error(`Slack API chat.postMessage failed: ${bodyJson.error ?? response.statusText}`);
  }
}

export async function postApprovalRequest(
  token: string,
  channel: string,
  threadTs: string,
  description: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const text = [
    "⚠️ Approval required",
    description,
    "React with :thumbsup: to approve or :thumbsdown: to deny."
  ].join("\n");

  await postMessage(token, channel, text, threadTs, fetchImpl);
}

export function mapThreadToDO(threadTs: string): string {
  return `slack-thread:${threadTs.trim()}`;
}
