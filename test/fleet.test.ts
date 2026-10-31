import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  // realpath expands Windows 8.3 short names (RUNNER~1) the way git reports paths.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fleet-")));
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

test("compare: diff stats, tests and token usage per worktree, ranked", async () => {
  const { diffStats, listWorktrees, parseShortstat, rankCandidates, renderComparison, runTests, usageFor } = await import("../src/compare.js");
  assert.deepEqual(parseShortstat(" 1 file changed, 2 insertions(+)"), { filesChanged: 1, insertions: 2, deletions: 0 });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fleet-cmp-")));
  const repo = join(root, "app");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "check.sh"), "exit 0\n");
  git("-C", repo, "add", ".");
  git("-C", repo, "commit", "-qm", "init");
  const a = join(root, "ws", "v1");
  const b = join(root, "ws", "v2");
  git("-C", repo, "worktree", "add", "-q", "-b", "feat/v1", a);
  git("-C", repo, "worktree", "add", "-q", "-b", "feat/v2", b);
  writeFileSync(join(a, "impl.txt"), "one\ntwo\n");
  git("-C", a, "add", ".");
  git("-C", a, "commit", "-qm", "v1");
  writeFileSync(join(b, "check.sh"), "echo boom\nexit 3\n"); // uncommitted, still counted
  writeFileSync(join(b, "notes.md"), "a\nb\nc\n"); // untracked, still counted
  writeFileSync(join(b, "empty.txt"), ""); // untracked and empty: a file, no lines

  assert.deepEqual(listWorktrees(repo).map(normalizePath), [a, b].map(normalizePath));
  const sa = diffStats(a, "main");
  assert.deepEqual([sa.branch, sa.commits, sa.insertions], ["feat/v1", 1, 2]);
  const sb = diffStats(b, "main");
  assert.deepEqual([sb.commits, sb.filesChanged, sb.insertions], [0, 3, 5]);
  assert.throws(() => diffStats(a, "no-such-branch"), /no-such-branch/);
  const { fullDiff } = await import("../src/judge.js");
  const fd = fullDiff(b, "main");
  assert.match(fd, /\+echo boom/);
  assert.match(fd, /\+\+\+ b\/notes\.md\n\+a/);

  const ta = runTests(a, "sh check.sh");
  const tb = runTests(b, "sh check.sh");
  assert.equal(ta.passed, true);
  assert.equal(tb.exitCode, 3);
  assert.match(tb.tail, /boom/);

  const base = { agent: "codex" as const, sessionId: "s", timestamp: "2026-10-30T10:00:00Z", model: "gpt-5", inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const tasks = summarizeTasks([{ ...base, cwd: a, branch: "feat/v1" }, { ...base, cwd: b, branch: "feat/v2" }, { ...base, cwd: b, branch: "feat/v2" }], gitResolver());
  const ua = usageFor(a, tasks);
  assert.equal(ua.tokens, 1e6);
  assert.ok(Math.abs(usageFor(b, tasks).costUsd - 2.5) < 1e-9);

  const ranked = rankCandidates([
    { worktree: b, ...sb, test: tb, ...usageFor(b, tasks) },
    { worktree: a, ...sa, test: ta, ...usageFor(a, tasks) },
  ]);
  assert.deepEqual(ranked.map((c) => c.branch), ["feat/v1", "feat/v2"]);
  const md = renderComparison("main", ranked, "sh check.sh");
  assert.match(md, /FAIL \(exit 3\)/);
});

test("judge: scores via structured output, skips empty or oversized diffs", async () => {
  const { judgeAttempt, judgePrompt, MAX_DIFF_CHARS } = await import("../src/judge.js");
  const score = { correctness: 5, scope: 4, quality: 4, tests: 3, overall: 8, summary: "Solves it.", risks: ["check x.ts"] };
  const calls: any[] = [];
  const fake = {
    messages: {
      parse: async (req: any) => {
        calls.push(req);
        return { stop_reason: "end_turn", parsed_output: score } as any;
      },
    },
  };
  const r = await judgeAttempt(fake as any, { brief: "add login", branch: "feat/a", diff: "+x", testSummary: "passed" });
  assert.equal(r.status, "scored");
  assert.equal(r.status === "scored" && r.score.overall, 8);
  assert.equal(calls[0].model, "claude-opus-5-5");
  assert.ok(calls[0].output_config.format, "uses structured output");
  assert.match(calls[0].messages[0].content, /<brief>\nadd login/);

  assert.deepEqual(await judgeAttempt(fake as any, { brief: "b", branch: "x", diff: "  " }), { status: "skipped", reason: "no changes" });
  const big = await judgeAttempt(fake as any, { brief: "b", branch: "x", diff: "x".repeat(MAX_DIFF_CHARS + 1) });
  assert.equal(big.status, "skipped");
  assert.equal(calls.length, 1, "skipped attempts make no API call");

  const refused = { messages: { parse: async () => ({ stop_reason: "refusal", parsed_output: null }) as any } };
  assert.equal((await judgeAttempt(refused as any, { brief: "b", branch: "x", diff: "+y" })).status, "skipped");
  assert.match(judgePrompt("b", "x", "d"), /<test_result>not run<\/test_result>/);
});

test("compare ranking uses judge score after tests; pick records decisions", async () => {
  const { rankCandidates, renderComparison } = await import("../src/compare.js");
  const { recordDecision, saveComparison, decisionsPath } = await import("../src/decisions.js");
  const base = { worktree: "/w", commits: 1, filesChanged: 1, insertions: 1, deletions: 0, agents: [], tokens: 0, calls: 0, costUsd: 1 };
  const pass = { passed: true, exitCode: 0, durationMs: 1, tail: "" };
  const scored = (overall: number) => ({ status: "scored" as const, model: "m", score: { correctness: 3, scope: 3, quality: 3, tests: 3, overall, summary: "s", risks: [] } });
  const ranked = rankCandidates([
    { ...base, branch: "low", test: pass, judge: scored(4), costUsd: 0.5 },
    { ...base, branch: "high", test: pass, judge: scored(9) },
    { ...base, branch: "failing", test: { ...pass, passed: false, exitCode: 1 }, judge: scored(10) },
  ]);
  assert.deepEqual(ranked.map((c) => c.branch), ["high", "low", "failing"]);
  assert.match(renderComparison("main", ranked), /\| 9\/10 \|/);

  const dir = mkdtempSync(join(tmpdir(), "fleet-pick-"));
  assert.throws(() => recordDecision(dir, "high"), /Run `agent-fleet compare` first/);
  saveComparison(dir, { comparedAt: "t", base: "main", candidates: ranked });
  assert.throws(() => recordDecision(dir, "nope"), /Candidates: high, low, failing/);
  assert.equal(recordDecision(dir, "low", "simpler").agreedWithRanking, false);
  assert.equal(recordDecision(dir, "high").agreedWithRanking, true);
  const lines = readFileSync(decisionsPath(dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((d) => [d.chosen, d.note]), [["low", "simpler"], ["high", undefined]]);
});
