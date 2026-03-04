import type { Env } from "./types";

const BLOB_ID = "blob";
const LEARNED_FILE_PATH = "/workspace/blob_state/learned.jsonl";

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
