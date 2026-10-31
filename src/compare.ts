import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePath } from "./tasks.js";
import type { AgentName, TaskSummary } from "./types.js";
import { totalTokens } from "./types.js";

export interface TestResult {
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Last lines of combined output, for a quick look at failures. */
  tail: string;
}

/** One attempt at a task: a worktree, its diff against the base, and what it cost. */
export interface Candidate {
  worktree: string;
  branch: string;
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  test?: TestResult;
  agents: AgentName[];
  tokens: number;
  costUsd: number;
  calls: number;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * All linked worktrees of the repo at `repoPath`, excluding the main checkout
 * and stale entries whose folder is gone.
 */
export function listWorktrees(repoPath: string): string[] {
  const out = git(repoPath, "worktree", "list", "--porcelain");
  const paths = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  return paths.slice(1).filter((p) => existsSync(p));
}

/** Parse `git diff --shortstat` output, e.g. " 3 files changed, 10 insertions(+), 2 deletions(-)". */
export function parseShortstat(s: string): { filesChanged: number; insertions: number; deletions: number } {
  const num = (re: RegExp) => Number(s.match(re)?.[1] ?? 0);
  return {
    filesChanged: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

/**
 * Diff stats against the merge base with `base`. Compares the working tree,
 * not just HEAD, because agents often leave their work uncommitted, and
 * counts new untracked files (git diff alone skips them).
 */
export function diffStats(worktree: string, base: string) {
  const branch = git(worktree, "rev-parse", "--abbrev-ref", "HEAD");
  let mergeBase: string;
  try {
    mergeBase = git(worktree, "merge-base", base, "HEAD");
  } catch {
    throw new Error(`${worktree} (${branch}): no common history with "${base}". Check --base (e.g. origin/main).`);
  }
  const commits = Number(git(worktree, "rev-list", "--count", `${mergeBase}..HEAD`));
  const stats = parseShortstat(git(worktree, "diff", "--shortstat", mergeBase));
  const untracked = git(worktree, "ls-files", "--others", "--exclude-standard").split(/\r?\n/).filter(Boolean);
  for (const file of untracked) {
    stats.filesChanged++;
    try {
      const content = readFileSync(join(worktree, file), "utf8");
      if (content) stats.insertions += content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
    } catch {
      // unreadable file: count it, not its lines
    }
  }
  return { branch, commits, ...stats };
}

export function runTests(worktree: string, command: string, timeoutMs = 10 * 60_000): TestResult {
  const start = Date.now();
  const r = spawnSync(command, { cwd: worktree, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    passed: r.status === 0,
    exitCode: r.status,
    durationMs: Date.now() - start,
    tail: output.split(/\r?\n/).filter(Boolean).slice(-15).join("\n"),
  };
}

/** Sum token usage of every task that ran in this worktree, across branches. */
export function usageFor(worktree: string, tasks: TaskSummary[]) {
  const key = normalizePath(worktree);
  const mine = tasks.filter((t) => t.worktree === key);
  return {
    agents: [...new Set(mine.flatMap((t) => t.agents))],
    tokens: mine.reduce((a, t) => a + totalTokens(t), 0),
    costUsd: mine.reduce((a, t) => a + t.costUsd, 0),
    calls: mine.reduce((a, t) => a + t.calls, 0),
  };
}

/** Passing tests first, then cheaper, then smaller diffs. */
export function rankCandidates(cs: Candidate[]): Candidate[] {
  const testScore = (c: Candidate) => (c.test === undefined ? 1 : c.test.passed ? 0 : 2);
  return [...cs].sort(
    (a, b) =>
      testScore(a) - testScore(b) ||
      a.costUsd - b.costUsd ||
      a.insertions + a.deletions - (b.insertions + b.deletions),
  );
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function renderComparison(base: string, ranked: Candidate[], testCommand?: string): string {
  const lines = [`# Compare approaches (base: \`${base}\`)`, ""];
  if (testCommand) lines.push(`Tests: \`${testCommand}\``, "");
  lines.push(
    "| # | Branch | Tests | Agents | Tokens | Est. cost | Commits | Files | +/- |",
    "|---:|---|---|---|---:|---:|---:|---:|---|",
  );
  ranked.forEach((c, i) => {
    const test = c.test ? (c.test.passed ? `pass (${(c.test.durationMs / 1000).toFixed(1)}s)` : `FAIL (exit ${c.test.exitCode})`) : "n/a";
    lines.push(
      `| ${i + 1} | \`${c.branch}\` | ${test} | ${c.agents.join(", ") || "-"} | ${tok(c.tokens)} | ${usd(c.costUsd)} | ${c.commits} | ${
        c.filesChanged
      } | +${c.insertions}/-${c.deletions} |`,
    );
  });
  lines.push("");
  const failed = ranked.filter((c) => c.test && !c.test.passed);
  for (const c of failed) {
    lines.push(`<details><summary>${c.branch}: test output</summary>`, "", "```", c.test!.tail || "(no output)", "```", "", "</details>", "");
  }
  lines.push("_Ranked by tests passed, then estimated cost, then diff size. You pick the winner._", "");
  return lines.join("\n");
}
