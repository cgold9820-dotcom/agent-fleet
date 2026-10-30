import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { costUsd, DEFAULT_PRICES, findPrice } from "../src/pricing.js";
import { buildReport, dayWindow, inWindow, renderMarkdown } from "../src/report.js";
import { readClaudeUsage } from "../src/sources/claude.js";
import { readCodexUsage } from "../src/sources/codex.js";
import { gitResolver, normalizePath, summarizeTasks, type WorktreeResolver } from "../src/tasks.js";

// Compiled tests live in dist/test; fixtures stay in the source tree.
const fixtures = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
const flatResolver: WorktreeResolver = (cwd) => ({ worktree: cwd, repo: cwd.split("/").pop()! });

test("claude: dedupes split records, skips synthetic and malformed lines", async () => {
  const events = await readClaudeUsage(join(fixtures, "claude"));
  assert.equal(events.length, 3);
  const login = events.filter((e) => e.branch === "feat/login");
  assert.equal(login.length, 2);
  assert.equal(login[0].inputTokens, 1000);
  assert.equal(login[0].cacheReadTokens, 5000);
  assert.equal(login[0].cacheWriteTokens, 2000);
});

test("codex: bills deltas of cumulative totals and splits cached input", async () => {
  const events = await readCodexUsage(join(fixtures, "codex"));
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.inputTokens, e.cacheReadTokens, e.outputTokens]),
    [
      [2000, 1000, 400],
      [2000, 3000, 500],
    ],
  );
  assert.equal(events[0].model, "gpt-5-codex");
  assert.equal(events[0].branch, "feat/login-v2");
});

test("pricing: longest prefix wins and cache rates apply", () => {
  assert.equal(findPrice("claude-opus-4-8-20260101")!.input, 5);
  assert.equal(findPrice("claude-opus-4-20250514")!.input, 15);
  assert.equal(findPrice("gpt-5-mini")!.input, 0.25);
  assert.equal(findPrice("mystery-model"), undefined);
  const c = costUsd({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }, DEFAULT_PRICES["claude-sonnet-4"]);
  assert.ok(Math.abs(c - (3 + 15 + 0.3 + 3.75)) < 1e-9);
});

test("tasks + report: groups by worktree/branch within the day window", async () => {
  const all = [...(await readClaudeUsage(join(fixtures, "claude"))), ...(await readCodexUsage(join(fixtures, "codex")))];
  const { from, to } = { from: new Date("2026-10-30T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") };
  const events = inWindow(all, from, to);
  const tasks = summarizeTasks(events, flatResolver);
  assert.deepEqual(tasks.map((t) => t.branch).sort(), ["feat/login", "feat/login-v2"]);
  const claudeTask = tasks.find((t) => t.branch === "feat/login")!;
  assert.equal(claudeTask.calls, 2);
  assert.equal(claudeTask.sessions, 1);
  assert.equal(claudeTask.inputTokens, 1500);

  const report = buildReport("2026-10-30", tasks, {});
  assert.equal(report.totals.tasks, 2);
  const md = renderMarkdown(report);
  assert.match(md, /# Agent fleet report: 2026-10-30/);
  assert.match(md, /feat\/login-v2/);
});

test("normalizePath unifies Windows and POSIX forms", () => {
  assert.equal(normalizePath("E:\\wishlist\\"), "e:/wishlist");
  assert.equal(normalizePath("/home/u/repo/"), "/home/u/repo");
});

test("dayWindow rejects bad dates", () => {
  assert.throws(() => dayWindow("30/10/2026"));
});

test("gitResolver maps a linked worktree back to its repo", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-"));
  const repo = join(root, "wishlist");
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" });
  git("init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "a");
  git("-C", repo, "add", ".");
  git("-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  const wt = join(root, "workspaces", "feat-x");
  git("-C", repo, "worktree", "add", "-q", "-b", "feat-x", wt);

  const info = gitResolver()(wt);
  assert.equal(info.repo, "wishlist");
  assert.equal(info.worktree, normalizePath(wt));
});

test("dashboard: buckets days, fills gaps, escapes HTML", async () => {
  const { dailyStats, renderDashboard } = await import("../src/dashboard.js");
  const base = { agent: "claude-code" as const, sessionId: "s", cwd: "/w", model: "m", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const from = new Date(2026, 9, 28);
  const events = [
    { ...base, timestamp: new Date(2026, 9, 28, 10).toISOString() },
    { ...base, timestamp: new Date(2026, 9, 30, 10).toISOString() },
    { ...base, timestamp: new Date(2026, 9, 30, 11).toISOString() },
  ];
  const days = dailyStats(events, from, 3, () => 1);
  assert.deepEqual(days.map((d) => d.costUsd), [1, 0, 2]);
  assert.deepEqual(days.map((d) => d.date), ["2026-10-28", "2026-10-29", "2026-10-30"]);
  const html = renderDashboard({ from: "2026-10-28", to: "2026-10-30", days, tasks: summarizeTasks(events.map((e) => ({ ...e, branch: "<b>x" })), flatResolver) });
  assert.match(html, /\$3\.00/);
  assert.ok(!html.includes("<b>x"));
});
