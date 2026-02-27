import type { ErrorFingerprintFields } from "../error-ingestion";

export type OpenPrLookup = (fingerprintId: string) => Promise<boolean>;

export function fingerprintToId(fingerprint: ErrorFingerprintFields): string {
  return [
    fingerprint.repository,
    fingerprint.source,
    fingerprint.code,
    fingerprint.filePath,
    String(fingerprint.line),
    fingerprint.normalizedMessage
  ]
    .join("|")
    .toLowerCase();
}

export async function shouldCreateRemediationPr(
  fingerprint: ErrorFingerprintFields,
  hasOpenPrForFingerprint: OpenPrLookup
): Promise<{ allowed: boolean; fingerprintId: string; reason?: string }> {
  const fingerprintId = fingerprintToId(fingerprint);
  const alreadyOpen = await hasOpenPrForFingerprint(fingerprintId);

  if (alreadyOpen) {
    return {
      allowed: false,
      fingerprintId,
      reason: "Open PR already exists for unresolved fingerprint"
    };
  }

  return {
    allowed: true,
    fingerprintId
  };
}
