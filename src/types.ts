export type AgentName = "claude-code" | "codex";

/** One billable model call, normalized across agents. */
export interface UsageEvent {
  agent: AgentName;
  sessionId: string;
  /** ISO timestamp of the call. */
  timestamp: string;
  /** Working directory the agent was running in. */
  cwd: string;
  /** Git branch reported by the agent, if any. */
  branch?: string;
  model: string;
  /** Uncached input tokens (billed at full input price). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** A task is one git worktree (+ branch): in Orca, one agent workspace. */
export interface TaskSummary extends TokenTotals {
  key: string;
  repo: string;
  worktree: string;
  branch: string;
  agents: AgentName[];
  models: string[];
  sessions: number;
  calls: number;
  costUsd: number;
  /** Models with no known price; their cost is counted as 0. */
  unpricedModels: string[];
  firstSeen: string;
  lastSeen: string;
  commits: string[];
}

export function emptyTotals(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function totalTokens(t: TokenTotals): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}
