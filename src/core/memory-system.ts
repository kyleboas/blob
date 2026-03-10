import type { Env } from "./types";
import { withDOAuth } from "./do-auth";
import { getSecretPatterns, redactSecrets as redactWithPatterns } from "./safety";
import { logEvent } from "./observability";
import { estimateTokens } from "./tokens";

export type MemoryScope = "thread" | "channel" | "team";
export type MemorySource = "thread" | "cron" | "compaction";

export interface MemoryItem {
  id: string;
  scope: string;
  content: string;
  created_at: string;
  updated_at: string;
  source: MemorySource;
  version: number;
  content_hash: string;
  token_estimate: number;
  unindexed?: boolean;
}

export interface LearnedEntry {
  timestamp: string;
  scope: string;
  category: "decision" | "fact" | "preference" | "lesson";
  content: string;
  confidence: "high" | "medium" | "low";
}


async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseMemoryItem(value: unknown): MemoryItem {
  return value as MemoryItem;
}

export async function embedText(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const response = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text }) as { data?: number[][] };
    return response.data?.[0] ?? null;
  } catch (err) {
    logEvent(env, "memory_ops", "embed_text_failed", { error: String(err) });
    return null;
  }
}

export class R2MemoryStore {
  constructor(private readonly bucket: R2Bucket) {}

  async create(item: Omit<MemoryItem, "id" | "created_at" | "updated_at" | "version" | "content_hash" | "token_estimate"> & { id?: string }): Promise<MemoryItem> {
    const now = new Date().toISOString();
    const id = item.id ?? crypto.randomUUID();
    const contentHash = await sha256Hex(item.content);
    const materialized: MemoryItem = {
      id,
      scope: item.scope,
      content: item.content,
      created_at: now,
      updated_at: now,
      source: item.source,
      version: 1,
      content_hash: contentHash,
      token_estimate: estimateTokens(item.content),
      unindexed: false,
    };
    await this.bucket.put(`mem/${id}.json`, JSON.stringify(materialized));
    return materialized;
  }

  async read(id: string): Promise<MemoryItem | null> {
    const obj = await this.bucket.get(`mem/${id}.json`);
    if (!obj) return null;
    return parseMemoryItem(await obj.json());
  }

  async update(id: string, patch: Partial<MemoryItem>): Promise<MemoryItem | null> {
    const existing = await this.read(id);
    if (!existing) return null;
    const content = patch.content ?? existing.content;
    const updated: MemoryItem = {
      ...existing,
      ...patch,
      content,
      content_hash: patch.content ? await sha256Hex(content) : existing.content_hash,
      token_estimate: patch.content ? estimateTokens(content) : existing.token_estimate,
      version: existing.version + 1,
      updated_at: new Date().toISOString(),
    };
    await this.bucket.put(`mem/${id}.json`, JSON.stringify(updated));
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.bucket.delete(`mem/${id}.json`);
  }

  async listByPrefix(prefix = "mem/"): Promise<MemoryItem[]> {
    const listed = await this.bucket.list({ prefix });
    const out: MemoryItem[] = [];
    for (const obj of listed.objects) {
      const item = await this.bucket.get(obj.key);
      if (!item) continue;
      out.push(parseMemoryItem(await item.json()));
    }
    return out;
  }
}

export async function upsertVector(env: Env, item: MemoryItem): Promise<void> {
  if (!env.PI_VECTORS) return;
  const vector = await embedText(env, item.content);
  if (!vector) return;
  await env.PI_VECTORS.upsert([
    {
      id: item.id,
      values: vector,
      metadata: {
        id: item.id,
        scope: item.scope,
        created_at: item.created_at,
        label: item.content.slice(0, 120),
      },
    },
  ]);
}

export async function queryVectors(env: Env, query: string, scope: string, topK: number): Promise<VectorizeMatch[]> {
  if (!env.PI_VECTORS) return [];
  const vector = await embedText(env, query);
  if (!vector) return [];
  const result = await env.PI_VECTORS.query(vector, {
    topK,
    filter: { scope },
    returnMetadata: "all",
  });
  return result.matches;
}

export async function deleteVector(env: Env, id: string): Promise<void> {
  if (!env.PI_VECTORS) return;
  await env.PI_VECTORS.deleteByIds([id]);
}

export async function validateIngestion(env: Env, scope: string, content: string): Promise<{ valid: boolean; reason?: string }> {
  if (getSecretPatterns(env).some((pattern) => pattern.test(content))) {
    return { valid: false, reason: "secret_detected" };
  }
  if (estimateTokens(content) > 2000) {
    return { valid: false, reason: "oversized" };
  }
  if (env.PI_VECTORS) {
    const near = await queryVectors(env, content, scope, 1);
    if (near[0]?.score && near[0].score > 0.95) {
      return { valid: false, reason: "duplicate" };
    }
  }
  return { valid: true };
}

export async function writeMemoryItem(env: Env, store: R2MemoryStore, params: { scope: string; content: string; source: MemorySource; id?: string }): Promise<MemoryItem> {
  logEvent(env, "memory_ops", "memory_write_attempt", { scope: params.scope, source: params.source });
  const validation = await validateIngestion(env, params.scope, params.content);
  if (!validation.valid) {
    throw new Error(`ingestion_rejected:${validation.reason}`);
  }
  const created = await store.create(params);
  await store.update(created.id, { unindexed: true });
  try {
    await upsertVector(env, created);
    const updated = await store.update(created.id, { unindexed: false });
    return updated ?? created;
  } catch (err) {
    logEvent(env, "memory_ops", "vector_upsert_failed", { error: String(err), id: created.id });
    const retained = await store.read(created.id);
    return retained ?? created;
  }
}

export async function recallMemory(env: Env, store: R2MemoryStore, query: string, scopes: string[], options?: { maxItems?: number; maxTokens?: number }): Promise<MemoryItem[]> {
  const maxItems = options?.maxItems ?? 10;
  const maxTokens = options?.maxTokens ?? 4000;
  const orderedScopes = [...scopes];
  const candidates: MemoryItem[] = [];
  const seen = new Set<string>();

  for (const scope of orderedScopes) {
    const matches = await queryVectors(env, query, scope, maxItems);
    for (const match of matches) {
      const id = String(match.id);
      const item = await store.read(id);
      if (!item) continue;
      if (seen.has(item.content_hash)) continue;
      seen.add(item.content_hash);
      candidates.push(item);
    }
  }

  const selected: MemoryItem[] = [];
  let tokens = 0;
  for (const item of candidates) {
    if (selected.length >= maxItems) break;
    if (tokens + item.token_estimate > maxTokens) break;
    selected.push(item);
    tokens += item.token_estimate;
  }
  return selected;
}

export function buildRetrievedMemoryBlock(items: MemoryItem[]): string {
  if (!items.length) return "";
  return [
    "Retrieved Memory:",
    ...items.map((item, idx) => `${idx + 1}. [${item.scope}] ${item.content}`),
  ].join("\n");
}

export function redactSecrets(input: string, env?: Pick<Env, "SECRET_PATTERNS">): string {
  return redactWithPatterns(input, env);
}

export async function extractLearnedEntries(env: Env, transcript: string, scope: string): Promise<LearnedEntry[]> {
  if (!env.AI) return [];
  const prompt = `Extract durable learnings as JSONL. Fields: timestamp, scope, category(decision|fact|preference|lesson), content(one sentence), confidence(high|medium|low). Input:\n${transcript}`;
  const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 800,
  }) as { response?: string };
  return parseLearnedJsonl(result.response ?? "", scope);
}

export function parseLearnedJsonl(jsonl: string, defaultScope: string): LearnedEntry[] {
  const lines = jsonl.split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed: LearnedEntry[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Partial<LearnedEntry>;
      if (!row.content) continue;
      parsed.push({
        timestamp: row.timestamp ?? new Date().toISOString(),
        scope: row.scope ?? defaultScope,
        category: (row.category as LearnedEntry["category"]) ?? "fact",
        content: redactSecrets(row.content),
        confidence: (row.confidence as LearnedEntry["confidence"]) ?? "medium",
      });
    } catch (_err) {
      continue;
    }
  }
  return parsed;
}

export async function appendDailyLearned(env: Env, date: string, entries: LearnedEntry[]): Promise<string> {
  const path = `/workspace/blob_state/daily/${date}.learned.jsonl`;
  const payload = entries.map((e) => JSON.stringify({ ...e, content: redactSecrets(e.content) })).join("\n") + (entries.length ? "\n" : "");
  let existing = "";
  try {
    existing = await env.SANDBOX.readFile(path);
  } catch (err) {
    logEvent(env, "memory_ops", "daily_learned_read_failed", { error: String(err), path });
    existing = "";
  }
  await env.SANDBOX.writeFile(path, `${existing}${payload}`);
  await env.REPO_STORE.put(`daily/${date}.learned.jsonl`, `${existing}${payload}`);
  return path;
}

export async function flushLearnedBeforeCompaction(env: Env, scope: string, transcript: string, date = new Date().toISOString().slice(0, 10)): Promise<LearnedEntry[]> {
  const entries = await extractLearnedEntries(env, transcript, scope);
  if (entries.length > 0) {
    logEvent(env, "memory_ops", "daily_learned_flush", { scope, entries: entries.length, date });
    await appendDailyLearned(env, date, entries);
  }
  return entries;
}

export interface RetentionConfig {
  maxItemsPerScope: number;
  maxAgeDays: number;
  maxTotalBytes: number;
}

export function applyRetention(items: MemoryItem[], config: RetentionConfig, now = Date.now()): { keep: MemoryItem[]; remove: MemoryItem[] } {
  const keep: MemoryItem[] = [];
  const remove: MemoryItem[] = [];
  const byScope = new Map<string, MemoryItem[]>();

  for (const item of items) {
    const arr = byScope.get(item.scope) ?? [];
    arr.push(item);
    byScope.set(item.scope, arr);
  }

  for (const [, scoped] of byScope) {
    scoped.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
    for (const [index, item] of scoped.entries()) {
      const ageDays = (now - Date.parse(item.created_at)) / (24 * 60 * 60 * 1000);
      if (index >= config.maxItemsPerScope || ageDays > config.maxAgeDays) {
        remove.push(item);
      } else {
        keep.push(item);
      }
    }
  }

  let totalBytes = keep.reduce((sum, item) => sum + item.content.length, 0);
  if (totalBytes > config.maxTotalBytes) {
    const sorted = [...keep].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    for (const item of sorted) {
      if (totalBytes <= config.maxTotalBytes) break;
      totalBytes -= item.content.length;
      remove.push(item);
      const idx = keep.findIndex((x) => x.id === item.id);
      if (idx >= 0) keep.splice(idx, 1);
    }
  }

  return { keep, remove };
}

export async function compactScope(env: Env, store: R2MemoryStore, scope: string): Promise<{ replaced: number; newItem?: MemoryItem }> {
  const scoped = (await store.listByPrefix("mem/")).filter((item) => item.scope === scope);
  if (scoped.length < 2) return { replaced: 0 };
  const selected = scoped.slice(0, Math.min(5, scoped.length));
  await flushLearnedBeforeCompaction(env, scope, selected.map((s) => s.content).join("\n"));
  const combined = selected.map((s) => `- ${s.content}`).join("\n");
  const summary = `Compacted notes:\n${combined}`;
  const created = await writeMemoryItem(env, store, { scope, content: summary, source: "compaction" });
  for (const item of selected) {
    await store.delete(item.id);
    await deleteVector(env, item.id);
  }
  return { replaced: selected.length, newItem: created };
}

// ---------------------------------------------------------------------------
// Legacy learned-record types and functions (migrated from memory.ts)
// ---------------------------------------------------------------------------

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

export async function appendLearnedRecord(env: Env, record: LearnedRecord): Promise<void> {
  const current = await env.SANDBOX.readFile(LEARNED_FILE_PATH).catch((err: unknown) => {
    logEvent(env, "memory_ops", "learned_file_read_failed", { error: String(err) });
    return "";
  });
  const line = `${JSON.stringify(record)}\n`;
  await env.SANDBOX.writeFile(LEARNED_FILE_PATH, `${current}${line}`);
}

export async function flushLearnedRecordsToR2(env: Env, conversationKey: string): Promise<{ key: string; count: number; lastRecord?: LearnedRecord }> {
  const content = await env.SANDBOX.readFile(LEARNED_FILE_PATH).catch((err: unknown) => {
    logEvent(env, "memory_ops", "learned_file_flush_read_failed", { error: String(err) });
    return "";
  });
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
    } catch (err) {
      logEvent(env, "memory_ops", "malformed_learned_line", { line: line.slice(0, 80), error: String(err) });
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

// ---------------------------------------------------------------------------
// DO fetch wrappers for memory status
// ---------------------------------------------------------------------------

export async function updateLearnedMemoryStatus(env: Env, payload: { lastFlushAt: string; lastFlushCount: number; lastRecordTimestamp?: string; lastRecordSummary?: string }): Promise<void> {
  try {
    const do_ = await getAgentDO(env);
    await do_.fetch("http://do/memory/learned/status", withDOAuth(env, {
      method: "POST",
      body: JSON.stringify(payload),
    }));
  } catch (err) {
    logEvent(env, "memory_ops", "learned_status_update_failed", { error: String(err) });
  }
}

export async function getLearnedMemoryStatus(env: Env): Promise<{ lastFlushAt: string | null; lastFlushCount: number }> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/memory/learned/status", withDOAuth(env));
    const data = await res.json() as { lastFlushAt: string | null; lastFlushCount: number };
    return {
      lastFlushAt: data.lastFlushAt,
      lastFlushCount: data.lastFlushCount ?? 0,
    };
  } catch (err) {
    logEvent(env, "memory_ops", "learned_status_get_failed", { error: String(err) });
    return { lastFlushAt: null, lastFlushCount: 0 };
  }
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
    await do_.fetch("http://do/memory/vectorize/status", withDOAuth(env, {
      method: "POST",
      body: JSON.stringify(payload),
    }));
  } catch (err) {
    logEvent(env, "memory_ops", "vectorize_status_update_failed", { error: String(err) });
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
    const res = await do_.fetch("http://do/memory/vectorize/status", withDOAuth(env));
    const data = await res.json() as {
      lastUpsertAt: string | null;
      lastUpsertOk: boolean | null;
      lastUpsertError: string | null;
      lastQueryAt: string | null;
      lastQueryCount: number;
    };
    return data;
  } catch (err) {
    logEvent(env, "memory_ops", "vectorize_status_get_failed", { error: String(err) });
    return {
      lastUpsertAt: null,
      lastUpsertOk: null,
      lastUpsertError: null,
      lastQueryAt: null,
      lastQueryCount: 0,
    };
  }
}

export async function getModelCatalog(env: Env): Promise<Record<string, { name: string; description: string; maxTokens: number }>> {
  try {
    const do_ = await getAgentDO(env);
    const res = await do_.fetch("http://do/catalog", withDOAuth(env));
    const data = await res.json() as { catalog: Record<string, { name: string; description: string; maxTokens: number }> };
    return data.catalog;
  } catch (err) {
    logEvent(env, "memory_ops", "model_catalog_get_failed", { error: String(err) });
    return {
      "anthropic/claude-sonnet-4-6": {
        name: "Claude Sonnet 4.6",
        description: "Best-in-class tool calling and code generation via AI Gateway.",
        maxTokens: 8192
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export async function reconcileMemory(env: Env, store: R2MemoryStore, vectorIds?: string[]): Promise<{ deletedOrphans: number; reindexed: number }> {
  let deletedOrphans = 0;
  let reindexed = 0;

  // If explicit vectorIds are provided, check those; otherwise discover orphans
  // by querying Vectorize for each known scope from R2 items
  const items = await store.listByPrefix("mem/");
  const r2Ids = new Set(items.map((i) => i.id));

  if (vectorIds && vectorIds.length > 0) {
    for (const id of vectorIds) {
      if (!r2Ids.has(id)) {
        await deleteVector(env, id);
        deletedOrphans += 1;
      }
    }
  } else if (env.PI_VECTORS) {
    // Discover orphans by querying Vectorize per scope
    const scopes = [...new Set(items.map((i) => i.scope))];
    const checkedIds = new Set<string>();
    for (const scope of scopes) {
      const matches = await queryVectors(env, " ", scope, 100);
      for (const match of matches) {
        const id = String(match.id);
        if (checkedIds.has(id)) continue;
        checkedIds.add(id);
        if (!r2Ids.has(id)) {
          await deleteVector(env, id);
          deletedOrphans += 1;
        }
      }
    }
  }

  // Re-index unindexed R2 items
  for (const item of items.filter((x) => x.unindexed)) {
    await upsertVector(env, item);
    await store.update(item.id, { unindexed: false });
    reindexed += 1;
  }

  return { deletedOrphans, reindexed };
}
