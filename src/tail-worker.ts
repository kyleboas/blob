/**
 * Tail Worker — centralizes logs from blob-agent and blob-sandbox into R2.
 *
 * Both workers emit structured JSON via console.log (see src/core/observability.ts).
 * This worker receives those log events and appends them to a daily JSONL file
 * in R2 under logs/YYYY-MM-DD.jsonl, making all logs queryable from one place.
 *
 * Each line in the JSONL file is the original structured log payload with an
 * extra `worker` field identifying which service produced it.
 */

interface Env {
  LOG_STORE: R2Bucket;
}

interface LogLine {
  worker: string;
  ts: string;
  [key: string]: unknown;
}

export default {
  async tail(events: TraceItem[], env: Env): Promise<void> {
    const lines: LogLine[] = [];

    for (const event of events) {
      const worker = event.scriptName ?? "unknown";

      for (const log of event.logs) {
        // Each message element may be a JSON string from logEvent() or a plain string.
        for (const msg of log.message) {
          try {
            const parsed = JSON.parse(String(msg));
            lines.push({ worker, ...parsed });
          } catch {
            // Plain console.log — wrap it.
            lines.push({
              worker,
              ts: new Date(log.timestamp).toISOString(),
              category: "raw",
              event: "console_log",
              data: { message: String(msg) },
            });
          }
        }
      }

      // Capture unhandled exceptions too.
      for (const ex of event.exceptions) {
        lines.push({
          worker,
          ts: new Date(ex.timestamp).toISOString(),
          category: "exception",
          event: "unhandled_exception",
          data: { name: ex.name, message: ex.message },
        });
      }
    }

    if (lines.length === 0) return;

    const date = lines[0].ts.slice(0, 10); // YYYY-MM-DD from first entry
    const key = `logs/${date}.jsonl`;
    const newContent = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

    // R2 doesn't support append natively — read existing content and rewrite.
    const existing = await env.LOG_STORE.get(key);
    const existingText = existing ? await existing.text() : "";

    await env.LOG_STORE.put(key, existingText + newContent, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  },
};
