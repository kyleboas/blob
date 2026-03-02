// sandbox/index.ts
// Minimal container "service" entrypoint for Cloudflare Sandbox base image.
// Keep this alive; the Sandbox runtime uses it to provide /api/*.

import http from "node:http";

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  // Simple OK for sanity; the sandbox runtime will handle /api/* itself.
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: true, service: "blob-sandbox", path: req.url }));
});

server.listen(port, "0.0.0.0", () => {
  // eslint-disable-next-line no-console
  console.log(`[container] listening on 0.0.0.0:${port}`);
});