export interface SlackEventEnvelope {
  team_id?: string;
  event?: {
    channel?: string;
    thread_ts?: string;
    ts?: string;
    channel_type?: string;
    user?: string;
  };
}

export function deriveRoutingKey(payload: SlackEventEnvelope): string {
  const teamId = payload.team_id ?? "unknown_team";
  const channelId = payload.event?.channel ?? "unknown_channel";
  const threadTs = payload.event?.thread_ts;
  const channelType = payload.event?.channel_type;
  const userId = payload.event?.user ?? "unknown_user";

  if (channelType === "im") {
    return `${teamId}:${userId}:dm`;
  }

  if (threadTs) {
    return `${teamId}:${channelId}:${threadTs}`;
  }

  return `${teamId}:${channelId}:channel`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySlackSignature(
  request: Request,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const signature = request.headers.get("x-slack-signature");
  const timestamp = request.headers.get("x-slack-request-timestamp");
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > 60 * 5) return false;

  const bodyText = await request.clone().text();
  const base = `v0:${timestamp}:${bodyText}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = `v0=${toHex(signed)}`;

  if (expected.length !== signature.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
