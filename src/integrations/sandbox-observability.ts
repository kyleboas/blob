export function summarizePath(path: string, maxChars = 120): string {
  if (path.length <= maxChars) return path;
  const edge = Math.max(16, Math.floor((maxChars - 1) / 2));
  return `${path.slice(0, edge)}…${path.slice(-edge)}`;
}

export function classifyCommandKind(command: string): string {
  const normalized = command.toLowerCase();
  const kinds: Array<[string, RegExp]> = [
    ["git", /\bgit\b/],
    ["node", /\bnode\b/],
    ["npm", /\bnpm\b/],
    ["bun", /\bbun\b/],
    ["python", /\bpython(?:3)?\b/],
    ["curl", /\bcurl\b/],
    ["wget", /\bwget\b/],
    ["bash", /\bbash\b/],
    ["sh", /\bsh\b/],
    ["grep", /\b(?:grep|rg)\b/],
    ["ls", /\bls\b/],
    ["mv", /\bmv\b/],
    ["cp", /\bcp\b/],
    ["rm", /\brm\b/],
    ["mkdir", /\bmkdir\b/],
  ];
  for (const [kind, pattern] of kinds) {
    if (pattern.test(normalized)) return kind;
  }
  return "custom";
}

export function estimateBytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
