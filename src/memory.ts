import type { Env } from "./types";

const BLOB_ID = "blob";

async function getAgentDO(env: Env): Promise<DurableObjectStub> {
  if (!env.BLOB) throw new Error("BLOB binding not found");
  return env.BLOB.get(env.BLOB.idFromName(BLOB_ID));
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