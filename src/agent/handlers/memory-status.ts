import type { BlobState } from "../do";

export type MemoryStatusHandlerCtx = {
  data: BlobState;
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function handleGetLearnedMemoryStatus(ctx: MemoryStatusHandlerCtx): Response {
  return json({
    lastFlushAt: ctx.data.learnedMemory?.lastFlushAt ?? null,
    lastFlushCount: ctx.data.learnedMemory?.lastFlushCount ?? 0,
    lastRecordTimestamp: ctx.data.learnedMemory?.lastRecordTimestamp ?? null,
    lastRecordSummary: ctx.data.learnedMemory?.lastRecordSummary ?? null,
  });
}

export async function handleSetLearnedMemoryStatus(request: Request, ctx: MemoryStatusHandlerCtx): Promise<Response> {
  const body = (await request.json()) as {
    lastFlushAt?: string;
    lastFlushCount?: number;
    lastRecordTimestamp?: string;
    lastRecordSummary?: string;
  };

  ctx.data.learnedMemory = {
    ...(ctx.data.learnedMemory ?? {}),
    ...body,
  };

  await ctx.save();
  return json({ saved: true, learnedMemory: ctx.data.learnedMemory });
}

export function handleGetVectorizeMemoryStatus(ctx: MemoryStatusHandlerCtx): Response {
  return json({
    lastUpsertAt: ctx.data.vectorizeMemory?.lastUpsertAt ?? null,
    lastUpsertOk: ctx.data.vectorizeMemory?.lastUpsertOk ?? null,
    lastUpsertError: ctx.data.vectorizeMemory?.lastUpsertError ?? null,
    lastQueryAt: ctx.data.vectorizeMemory?.lastQueryAt ?? null,
    lastQueryCount: ctx.data.vectorizeMemory?.lastQueryCount ?? 0,
  });
}

export async function handleSetVectorizeMemoryStatus(request: Request, ctx: MemoryStatusHandlerCtx): Promise<Response> {
  const body = (await request.json()) as {
    lastUpsertAt?: string;
    lastUpsertOk?: boolean;
    lastUpsertError?: string;
    lastQueryAt?: string;
    lastQueryCount?: number;
  };

  ctx.data.vectorizeMemory = {
    ...(ctx.data.vectorizeMemory ?? {}),
    ...body,
  };

  await ctx.save();
  return json({ saved: true, vectorizeMemory: ctx.data.vectorizeMemory });
}
