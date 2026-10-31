import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { costUsd, DEFAULT_PRICES, findPrice, type ModelPrice } from "./pricing.js";
import type { TaskSummary, UsageEvent } from "./types.js";

export interface WorktreeInfo {
  /** Top-level directory of the worktree the cwd belongs to. */
  worktree: string;
  /** Name of the repository (shared by all its worktrees). */
  repo: string;
}

export type WorktreeResolver = (cwd: string) => WorktreeInfo;

/** Normalize Windows/POSIX paths so the same folder always maps to one key. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

/**
 * Resolve a cwd to its git worktree via `git rev-parse`. Every Orca workspace
 * is its own worktree, so the worktree path identifies the task, and the
 * common git dir identifies the repo. Falls back to the cwd itself when the
 * folder is gone or is not a git checkout.
 */
export function gitResolver(): WorktreeResolver {
  const cache = new Map<string, WorktreeInfo>();
  return (cwd) => {
    const hit = cache.get(cwd);
    if (hit) return hit;
    let info: WorktreeInfo = { worktree: normalizePath(cwd), repo: basename(normalizePath(cwd)) || "(unknown)" };
    if (cwd && existsSync(cwd)) {
      try {
        const out = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const [top, common] = out.trim().split(/\r?\n/);
        const commonDir = normalizePath(common);
        info = {
          worktree: normalizePath(top),
          repo: basename(commonDir.endsWith("/.git") ? dirname(commonDir) : commonDir),
        };
      } catch {
        // not a git repo; keep the fallback
      }
    }
    cache.set(cwd, info);
    return info;
  };
}

/** Group usage events into per-worktree tasks with token and cost totals. */
export function summarizeTasks(
  events: UsageEvent[],
  resolve: WorktreeResolver,
  prices: Record<string, ModelPrice> = DEFAULT_PRICES,
): TaskSummary[] {
  const tasks = new Map<string, TaskSummary & { _sessions: Set<string> }>();
  for (const e of events) {
    const { worktree, repo } = resolve(e.cwd);
    const branch = e.branch ?? "(no branch)";
    const key = `${worktree}::${branch}`;
    let t = tasks.get(key);
    if (!t) {
      t = {
        key,
        repo,
        worktree,
        branch,
        agents: [],
        models: [],
        sessions: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        unpricedModels: [],
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
        commits: [],
        _sessions: new Set(),
      };
      tasks.set(key, t);
    }
    t.calls++;
    t._sessions.add(e.sessionId);
    if (!t.agents.includes(e.agent)) t.agents.push(e.agent);
    if (!t.models.includes(e.model)) t.models.push(e.model);
    t.inputTokens += e.inputTokens;
    t.outputTokens += e.outputTokens;
    t.cacheReadTokens += e.cacheReadTokens;
    t.cacheWriteTokens += e.cacheWriteTokens;
    const price = findPrice(e.model, prices);
    if (price) t.costUsd += costUsd(e, price);
    else if (!t.unpricedModels.includes(e.model)) t.unpricedModels.push(e.model);
    if (e.timestamp < t.firstSeen) t.firstSeen = e.timestamp;
    if (e.timestamp > t.lastSeen) t.lastSeen = e.timestamp;
  }
  return [...tasks.values()]
    .map(({ _sessions, ...t }) => ({ ...t, sessions: _sessions.size }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** Commits made in a worktree's branch within [from, to). Empty if unavailable. */
export function commitsBetween(worktree: string, from: Date, to: Date): string[] {
  if (!existsSync(worktree)) return [];
  try {
    const out = execFileSync(
      "git",
      ["-C", worktree, "log", "HEAD", `--since=${from.toISOString()}`, `--until=${to.toISOString()}`, "--no-merges", "--format=%h %s"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Attach Orca workspace names (or any path-keyed names) to tasks. */
export function attachNames(tasks: TaskSummary[], names: Map<string, { name: string }>): void {
  const lookup = new Map([...names].map(([path, n]) => [pathKey(path), n]));
  for (const t of tasks) {
    const n = lookup.get(pathKey(t.worktree));
    if (n) t.name = n.name;
  }
}

/** Windows paths compare case-insensitively; POSIX paths do not. */
export function pathKey(p: string): string {
  const n = normalizePath(p);
  return /^[a-z]:/.test(n) ? n.toLowerCase() : n;
}
