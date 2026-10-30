import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageEvent } from "../types.js";
import { findFiles, readJsonl } from "./jsonl.js";

export function codexSessionsDir(): string {
  const base = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(base, "sessions");
}

interface CodexTotals {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

/**
 * Read Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
 * session_meta gives cwd and git branch, turn_context gives the model, and
 * token_count events carry a cumulative total_token_usage. We bill the delta
 * between consecutive totals, which is robust to repeated token_count events.
 * OpenAI counts cached tokens inside input_tokens, so we split them out.
 */
export async function readCodexUsage(dir = codexSessionsDir(), since?: Date): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for (const file of findFiles(dir, /^rollout-.*\.jsonl$/, since)) {
    let sessionId = file;
    let cwd = "";
    let branch: string | undefined;
    let model = "unknown";
    let prev: Required<CodexTotals> = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };

    for await (const rec of readJsonl(file)) {
      const p = rec?.payload;
      if (!p) continue;
      if (rec.type === "session_meta") {
        sessionId = p.id ?? sessionId;
        cwd = p.cwd ?? cwd;
        branch = p.git?.branch ?? branch;
        if (p.model) model = p.model;
      } else if (rec.type === "turn_context") {
        if (p.model) model = p.model;
        if (p.cwd) cwd = p.cwd;
      } else if (rec.type === "event_msg" && p.type === "token_count") {
        const total: CodexTotals | undefined = p.info?.total_token_usage;
        if (!total || !rec.timestamp) continue;
        const cur = {
          input_tokens: total.input_tokens ?? 0,
          cached_input_tokens: total.cached_input_tokens ?? 0,
          output_tokens: total.output_tokens ?? 0,
        };
        // A smaller total means the counter restarted; treat it as fresh.
        const base = cur.input_tokens < prev.input_tokens ? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } : prev;
        const dIn = cur.input_tokens - base.input_tokens;
        const dCached = cur.cached_input_tokens - base.cached_input_tokens;
        const dOut = cur.output_tokens - base.output_tokens;
        prev = cur;
        if (dIn <= 0 && dOut <= 0) continue;
        events.push({
          agent: "codex",
          sessionId,
          timestamp: rec.timestamp,
          cwd,
          branch,
          model,
          inputTokens: Math.max(0, dIn - dCached),
          outputTokens: Math.max(0, dOut),
          cacheReadTokens: Math.max(0, dCached),
          cacheWriteTokens: 0,
        });
      }
    }
  }
  return events;
}
