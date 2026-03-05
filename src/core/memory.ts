import type { Env } from "./types";

const BLOB_ID = "blob";
const LEARNED_FILE_PATH = "/workspace/blob_state/learned.jsonl";
const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export interface SemanticMemoryMatch {
  id: string;
  score: number;
  conversationKey?: string;
  r2Key?: string;
  snippet?: string;
  timestamp?: string;
}

export interface LearnedRecord {
  timestamp: string;
  conversationKey: string;
  summary: string;
  tags: string[];
  sourceRefs?: string[];
}

async function getAgentDO(env: Env): Promise<DurableObjectStub> {
  if (!env.AGENT_DO) throw new Error("AGENT_DO binding not found");
  return env.AGENT_DO.get(env.AGENT_DO.idFromName(BLOB_ID));
}

export async function saveMessage(env: Env, role: string, content: string): Promise<void> {
  try {
    const do_ = await getAgentDO(env);
    await do_.fetch("http://do/messages", {
      method: "POST",
      body: JSON.stringify({ role, content }),
    });
  } catch {
    // Silently fail
  }
}

export async function getRecentMessages(env: Env, limit = 10): Promise<Array<{ role: string; content: string; timestamp: number }>> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch(`http://do/messages?limit=${limit}`);
    const data = await res.json() as { messages: Array<{ role: string; content: string; timestamp: number }> };
    return data.messages;
  } catch {
    return [];
  }
}

export async function savePreference(env: Env, key: string, value: string): Promise<void> {
  try {
    const do_ = await getAgentDO(env);
    await do_.fetch("http://do/preferences", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
  } catch {
    // Silently fail
  }
}

export async function getModelCatalog(env: Env): Promise<Record<string, { name: string; description: string; maxTokens: number }>> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/catalog");
    const data = await res.json() as { catalog: Record<string, { name: string; description: string; maxTokens: number }> };
    return data.catalog;
  } catch {
    return {
      "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
        name: "Llama 3.3 70B Fast",
        description: "Fast, capable model for most coding tasks. Free tier.",
        maxTokens: 4096
      }
    };
  }
}

export async function updateModelCatalog(env: Env, catalog: Record<string, { name: string; description: string; maxTokens: number }>): Promise<void> {
  try {
    const do_ = await getAgentDO(env);
    await do_.fetch("http://do/catalog", {
      method: "POST",
      body: JSON.stringify({ catalog }),
    });
  } catch {
    // Silently fail
  }
}

export async function triggerCatalogUpdate(env: Env): Promise<{ updated: boolean; count?: number; reason?: string }> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/catalog/update", { 
      method: "POST",
      body: JSON.stringify({
        cfToken: env.CLOUDFLARE_API_TOKEN,
        accountId: env.ACCOUNT_ID
      })
    });
    return await res.json() as { updated: boolean; count?: number; reason?: string };
  } catch {
    return { updated: false, reason: "Failed to trigger update" };
  }
}

export async function appendLearnedRecord(env: Env, record: LearnedRecord): Promise<void> {
  const current = await env.SANDBOX.readFile(LEARNED_FILE_PATH).catch(() => "");
  const line = `${JSON.stringify(record)}\n`;
  await env.SANDBOX.writeFile(LEARNED_FILE_PATH, `${current}${line}`);
}

export async function flushLearnedRecordsToR2(env: Env, conversationKey: string): Promise<{ key: string; count: number; lastRecord?: LearnedRecord }> {
  const content = await env.SANDBOX.readFile(LEARNED_FILE_PATH).catch(() => "");
  const trimmed = content.trim();
  if (!trimmed) {
    return { key: "", count: 0 };
  }

  const rows: LearnedRecord[] = [];
  for (const rawLine of trimmed.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as LearnedRecord);
    } catch {
      // ignore malformed lines
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const key = `memory/${conversationKey}/${date}/learned.jsonl`;
  const existing = await env.REPO_STORE.get(key);
  const existingText = existing ? await existing.text() : "";
  await env.REPO_STORE.put(key, `${existingText}${content.endsWith("\n") ? content : `${content}\n`}`);
  await env.SANDBOX.writeFile(LEARNED_FILE_PATH, "");
  return { key, count: rows.length, lastRecord: rows[rows.length - 1] };
}

export async function updateLearnedMemoryStatus(env: Env, payload: { lastFlushAt: string; lastFlushCount: number; lastRecordTimestamp?: string; lastRecordSummary?: string }): Promise<void> {
  try {
    const do_ = await getAgentDO(env);
    await do_.fetch("http://do/memory/learned/status", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    // best effort
  }
}

export async function getLearnedMemoryStatus(env: Env): Promise<{ lastFlushAt: string | null; lastFlushCount: number }> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/memory/learned/status");
    const data = await res.json() as { lastFlushAt: string | null; lastFlushCount: number };
    return {
      lastFlushAt: data.lastFlushAt,
      lastFlushCount: data.lastFlushCount ?? 0,
    };
  } catch {
    return { lastFlushAt: null, lastFlushCount: 0 };
  }
}

export async function embedText(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  const response = await env.AI.run(EMBEDDING_MODEL, { text }) as { data?: number[][] };
  return response.data?.[0] ?? null;
}

export function buildVectorId(conversationKey: string, timestamp: string): string {
  return `conv:${conversationKey}:${timestamp}`;
}

export async function upsertSemanticMemory(env: Env, params: {
  conversationKey: string;
  record: LearnedRecord;
  r2Key: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.PI_VECTORS) {
    return { ok: false, error: "PI_VECTORS binding missing" };
  }
  const vector = await embedText(env, `${params.record.summary}\n${params.record.tags.join(" ")}`);
  if (!vector) {
    return { ok: false, error: "embedding generation failed" };
  }
  const id = buildVectorId(params.conversationKey, params.record.timestamp);
  await env.PI_VECTORS.upsert([
    {
      id,
      values: vector,
      metadata: {
        conversationKey: params.conversationKey,
        r2Key: params.r2Key,
        snippet: params.record.summary.slice(0, 240),
        timestamp: params.record.timestamp,
      },
    },
  ]);
  return { ok: true, id };
}

export async function querySemanticMemory(env: Env, params: {
  conversationKey: string;
  query: string;
  topK?: number;
}): Promise<SemanticMemoryMatch[]> {
  if (!env.PI_VECTORS) return [];
  const vector = await embedText(env, params.query);
  if (!vector) return [];
  const result = await env.PI_VECTORS.query(vector, {
    topK: params.topK ?? 5,
    returnMetadata: "all",
    filter: { conversationKey: params.conversationKey },
  });

  return (result.matches ?? []).map((match) => {
    const metadata = (match.metadata ?? {}) as Record<string, unknown>;
    return {
      id: String(match.id),
      score: Number(match.score ?? 0),
      conversationKey: typeof metadata.conversationKey === "string" ? metadata.conversationKey : undefined,
      r2Key: typeof metadata.r2Key === "string" ? metadata.r2Key : undefined,
      snippet: typeof metadata.snippet === "string" ? metadata.snippet : undefined,
      timestamp: typeof metadata.timestamp === "string" ? metadata.timestamp : undefined,
    };
  });
}

export async function buildSemanticMemoryContext(env: Env, matches: SemanticMemoryMatch[], maxChars = 1200): Promise<string> {
  const lines: string[] = [];
  let total = 0;
  for (const match of matches) {
    let snippet = match.snippet ?? "";
    if (!snippet && match.r2Key) {
      const obj = await env.REPO_STORE.get(match.r2Key);
      if (obj) {
        const firstLine = (await obj.text()).split("\n").find((line) => line.trim().length > 0) ?? "";
        snippet = firstLine.slice(0, 240);
      }
    }
    if (!snippet) continue;
    const line = `- ${snippet}`;
    if (total + line.length > maxChars) break;
    lines.push(line);
    total += line.length;
  }

  return lines.length > 0 ? `Relevant learned memory:\n${lines.join("\n")}` : "";
}

export async function updateVectorizeMemoryStatus(env: Env, payload: {
  lastUpsertAt?: string;
  lastUpsertOk?: boolean;
  lastUpsertError?: string;
  lastQueryAt?: string;
  lastQueryCount?: number;
}): Promise<void> {
  try {
    const do_ = await getAgentDO(env);
    await do_.fetch("http://do/memory/vectorize/status", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch {
    // best effort
  }
}

export async function getVectorizeMemoryStatus(env: Env): Promise<{
  lastUpsertAt: string | null;
  lastUpsertOk: boolean | null;
  lastUpsertError: string | null;
  lastQueryAt: string | null;
  lastQueryCount: number;
}> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/memory/vectorize/status");
    const data = await res.json() as {
      lastUpsertAt: string | null;
      lastUpsertOk: boolean | null;
      lastUpsertError: string | null;
      lastQueryAt: string | null;
      lastQueryCount: number;
    };
    return data;
  } catch {
    return {
      lastUpsertAt: null,
      lastUpsertOk: null,
      lastUpsertError: null,
      lastQueryAt: null,
      lastQueryCount: 0,
    };
  }
}
