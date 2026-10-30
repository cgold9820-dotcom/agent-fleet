import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageEvent } from "../types.js";
import { findFiles, readJsonl } from "./jsonl.js";

export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(base, "projects");
}

/**
 * Read Claude Code transcripts (~/.claude/projects/<slug>/*.jsonl).
 * Each assistant record carries message.usage, cwd and gitBranch. A single API
 * response is split across several records (one per content block) that repeat
 * the same usage, so we dedupe on message.id + requestId.
 */
export async function readClaudeUsage(dir = claudeProjectsDir(), since?: Date): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const seen = new Set<string>();
  for (const file of findFiles(dir, /\.jsonl$/, since)) {
    for await (const rec of readJsonl(file)) {
      if (rec?.type !== "assistant") continue;
      const msg = rec.message;
      const usage = msg?.usage;
      if (!usage || !rec.timestamp) continue;
      if (msg.model === "<synthetic>") continue;
      const id = `${msg.id ?? ""}:${rec.requestId ?? ""}`;
      if (id !== ":" && seen.has(id)) continue;
      seen.add(id);
      events.push({
        agent: "claude-code",
        sessionId: rec.sessionId ?? file,
        timestamp: rec.timestamp,
        cwd: rec.cwd ?? "",
        branch: rec.gitBranch || undefined,
        model: msg.model ?? "unknown",
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      });
    }
  }
  return events;
}
