import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests") continue;
      out.push(...listTsFiles(full));
      continue;
    }
    if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function extractCatchBodies(content: string): string[] {
  const bodies: string[] = [];
  const catchRegex = /catch\s*(?:\([^)]*\))?\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = catchRegex.exec(content))) {
    let i = match.index + match[0].length;
    let depth = 1;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      i += 1;
    }
    bodies.push(content.slice(match.index + match[0].length, i - 1));
  }
  return bodies;
}

function withoutComments(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .trim();
}

test("source files do not contain silent catch blocks", () => {
  const srcRoot = path.join(process.cwd(), "src");
  const offenders: string[] = [];

  for (const file of listTsFiles(srcRoot)) {
    const content = fs.readFileSync(file, "utf8");
    const bodies = extractCatchBodies(content);
    for (const body of bodies) {
      if (withoutComments(body).length === 0) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
  }

  assert.deepEqual(offenders, []);
});
