// Container module for Cloudflare Sandbox base image.
// The base image's internal Bun server handles all /api/* requests on port 3000.
// Do NOT bind to port 3000 — it is reserved by the sandbox runtime.
export {};
