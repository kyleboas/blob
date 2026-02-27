import type { ErrorSource, SelfHealingPolicy } from "../config/policy";

export interface SourceErrorPayload {
  source: ErrorSource;
  repository: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  code?: string;
  raw: unknown;
}

export interface ErrorFingerprintFields {
  repository: string;
  source: ErrorSource;
  code: string;
  filePath: string;
  line: number;
  normalizedMessage: string;
}

export interface NormalizedError {
  source: ErrorSource;
  repository: string;
  message: string;
  filePath: string;
  line: number;
  column: number;
  code: string;
  raw: unknown;
  fingerprint: ErrorFingerprintFields;
}

export const V1_IN_SCOPE_ERROR_SOURCES: ErrorSource[] = ["ci", "runtime", "lint", "typecheck", "test"];

function sanitizeMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#").trim();
}

function buildFingerprintFields(payload: SourceErrorPayload): ErrorFingerprintFields {
  return {
    repository: payload.repository,
    source: payload.source,
    code: payload.code ?? "UNKNOWN",
    filePath: payload.filePath ?? "unknown",
    line: payload.line ?? 0,
    normalizedMessage: sanitizeMessage(payload.message)
  };
}

export function normalizeErrorPayload(payload: SourceErrorPayload): NormalizedError {
  return {
    source: payload.source,
    repository: payload.repository,
    message: payload.message.trim(),
    filePath: payload.filePath ?? "unknown",
    line: payload.line ?? 0,
    column: payload.column ?? 0,
    code: payload.code ?? "UNKNOWN",
    raw: payload.raw,
    fingerprint: buildFingerprintFields(payload)
  };
}

export function ingestErrors(
  payloads: SourceErrorPayload[],
  policy: Pick<SelfHealingPolicy, "inScopeErrorSources">
): NormalizedError[] {
  const inScope = new Set(policy.inScopeErrorSources);
  return payloads.filter((payload) => inScope.has(payload.source)).map(normalizeErrorPayload);
}
