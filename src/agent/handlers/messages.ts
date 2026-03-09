import type { BlobState } from "../do";

export type MessagesHandlerCtx = {
  state: DurableObjectState;
  data: BlobState;
  save: () => Promise<void>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleStoreMessage(request: Request, ctx: MessagesHandlerCtx): Promise<Response> {
  const { role, content } = (await request.json()) as { role: string; content: string };
  ctx.data.messages.push({ role, content, timestamp: Date.now() });

  if (ctx.data.messages.length > 100) {
    ctx.data.messages = ctx.data.messages.slice(-100);
    await ctx.save();
    return json({ saved: true });
  }

  if (ctx.data.messages.length > 25) {
    const toSummarize = ctx.data.messages.slice(0, -20);
    const summary = `[${toSummarize.length} older messages summarized]`;
    ctx.data.messages = [{ role: "system", content: summary, timestamp: Date.now() }, ...ctx.data.messages.slice(-20)];
    await ctx.save();
    return json({ saved: true });
  }

  await ctx.save();
  return json({ saved: true });
}

export function handleListMessages(url: URL, ctx: MessagesHandlerCtx): Response {
  const limit = parseInt(url.searchParams.get("limit") || "10");
  return json({ messages: ctx.data.messages.slice(-limit) });
}
