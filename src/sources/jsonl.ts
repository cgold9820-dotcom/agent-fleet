import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Recursively list files under `dir` whose name matches `pattern`. */
export function findFiles(dir: string, pattern: RegExp, modifiedSince?: Date): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (pattern.test(entry.name)) {
        if (modifiedSince && statSync(p).mtime < modifiedSince) continue;
        out.push(p);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Yield parsed JSON objects from a JSONL file, skipping malformed lines. */
export async function* readJsonl(file: string): AsyncGenerator<any> {
  const rl = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Agents can be mid-write; a partial last line is expected.
    }
  }
}
