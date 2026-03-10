import type { Env } from "./types";

const DEFAULT_SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]\s*['\"]?[a-z0-9_\-]{10,}/gi,
  /token\s*[:=]\s*['\"]?[a-z0-9_\-]{10,}/gi,
  /password\s*[:=]\s*['\"]?\S{8,}/gi,
  /https?:\/\/x-access-token:[^@\s]+@/gi,
  /(?:authorization|auth|token|secret)[^\n]{0,40}[=:]\s*["']?[A-Za-z0-9+/=]{40,}["']?/gi,
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/gi,
];

function parsePattern(raw: string): RegExp | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("/") && trimmed.lastIndexOf("/") > 0) {
      const last = trimmed.lastIndexOf("/");
      return new RegExp(trimmed.slice(1, last), trimmed.slice(last + 1) || "gi");
    }
    return new RegExp(trimmed, "gi");
  } catch (err) {
    console.error("parsePattern failed", err);
    return null;
  }
}

export function getSecretPatterns(env?: Pick<Env, "SECRET_PATTERNS">): RegExp[] {
  const fromEnv = env?.SECRET_PATTERNS
    ?.split("\n")
    .flatMap((line) => line.split(","))
    .map(parsePattern)
    .filter((v): v is RegExp => Boolean(v)) ?? [];
  return [...DEFAULT_SECRET_PATTERNS, ...fromEnv];
}

export function redactSecrets(input: string, env?: Pick<Env, "SECRET_PATTERNS">): string {
  let output = input;
  for (const pattern of getSecretPatterns(env)) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

export function redactUnknown(value: unknown, env?: Pick<Env, "SECRET_PATTERNS">): unknown {
  if (typeof value === "string") return redactSecrets(value, env);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item, env));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactUnknown(v, env);
    return out;
  }
  return value;
}
