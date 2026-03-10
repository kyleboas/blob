import type { BlobState } from "../do";

export type SecretsHandlerCtx = {
  state: DurableObjectState;
  data: BlobState;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function handleListSecrets(ctx: SecretsHandlerCtx): Response {
  const rows = ctx.state.storage.sql.exec("SELECT name FROM service_secrets ORDER BY name ASC");
  return json({ secrets: [...rows].map((r) => String(r.name)) });
}

export function getSecretsForInjection(storage: DurableObjectStorage): Record<string, string> {
  const rows = storage.sql.exec("SELECT name, value FROM service_secrets ORDER BY name ASC");
  const secrets: Record<string, string> = {};
  for (const row of rows) {
    secrets[String(row.name)] = String(row.value);
  }
  return secrets;
}

export async function handleSaveSecret(request: Request, ctx: SecretsHandlerCtx): Promise<Response> {
  const { name, value } = (await request.json()) as { name: string; value: string };
  if (!name || !value) return json({ error: "name and value required" }, 400);

  const now = Date.now();
  const existing = ctx.state.storage.sql.exec("SELECT name FROM service_secrets WHERE name=?", name).toArray();
  if (existing.length > 0) {
    ctx.state.storage.sql.exec("UPDATE service_secrets SET value=?, updated_at=? WHERE name=?", value, now, name);
  } else {
    ctx.state.storage.sql.exec(
      "INSERT INTO service_secrets (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)",
      name,
      value,
      now,
      now,
    );
  }

  return json({ saved: name });
}

export async function handleDeleteSecret(request: Request, ctx: SecretsHandlerCtx): Promise<Response> {
  const { name } = (await request.json()) as { name: string };
  ctx.state.storage.sql.exec("DELETE FROM service_secrets WHERE name=?", name);
  return json({ deleted: name });
}
