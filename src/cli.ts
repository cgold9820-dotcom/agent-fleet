#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { costUsd, findPrice, loadPricing } from "./pricing.js";
import { diffStats, listWorktrees, rankCandidates, renderComparison, runTests, usageFor, type Candidate } from "./compare.js";
import { dailyStats, renderDashboard } from "./dashboard.js";
import { decisionsPath, recordDecision, saveComparison } from "./decisions.js";
import { DEFAULT_JUDGE_MODEL, fullDiff, judgeAttempt } from "./judge.js";
import { agentBreakdown, buildReport, dayWindow, inWindow, localDate, renderMarkdown } from "./report.js";
import { readClaudeUsage } from "./sources/claude.js";
import { readCodexUsage } from "./sources/codex.js";
import { readOrcaWorkspaces } from "./sources/orca.js";
import { attachNames, commitsBetween, gitResolver, summarizeTasks } from "./tasks.js";
import type { UsageEvent } from "./types.js";

const HELP = `agent-fleet: token & cost accounting for parallel coding agents

Usage:
  agent-fleet report [--date YYYY-MM-DD] [--out FILE] [--json] [--pricing FILE]
  agent-fleet dashboard [--days 14] [--out reports/dashboard.html] [--pricing FILE]
  agent-fleet compare <worktree>... | --worktrees-of <repo>  [--base main] [--test CMD] [--days 30]
                      [--judge --brief "what the task asked for" [--model ID]]
  agent-fleet pick <branch> [--note "why"]

Options:
  --date      Day to report on, local time (default: today)
  --days      Days of logs to include, ending today (dashboard: 14, compare: 30)
  --base      Branch the compared worktrees started from (default: main)
  --test      Command run in each worktree; exit code 0 counts as passing
  --worktrees-of  Compare every linked worktree of this repo
  --judge     Have Claude score each attempt's diff against --brief (needs ANTHROPIC_API_KEY)
  --brief     The task description the attempts were given (or --brief-file FILE)
  --model     Judge model (default: ${DEFAULT_JUDGE_MODEL})
  --note      Why you picked this candidate (stored with the decision)
  --out       Write the report to FILE instead of stdout
  --json      Emit JSON instead of Markdown
  --pricing   JSON file of per-model prices (USD per 1M tokens) to override defaults
  --claude-dir, --codex-dir   Override log locations
  --orca-db   Orca profile database for workspace names (default: Orca's standard location)

Reads Claude Code (~/.claude/projects) and Codex (~/.codex/sessions) logs locally.
Nothing leaves your machine.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      date: { type: "string" },
      days: { type: "string" },
      base: { type: "string", default: "main" },
      test: { type: "string" },
      "worktrees-of": { type: "string" },
      judge: { type: "boolean", default: false },
      brief: { type: "string" },
      "brief-file": { type: "string" },
      model: { type: "string" },
      note: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      pricing: { type: "string" },
      "claude-dir": { type: "string" },
      "codex-dir": { type: "string" },
      "orca-db": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }
  if (cmd === "pick") {
    const chosen = positionals[1];
    if (!chosen) throw new Error("Usage: agent-fleet pick <branch> [--note \"why\"]");
    const d = recordDecision(process.cwd(), chosen, values.note);
    console.log(`Picked ${d.chosen}${d.agreedWithRanking ? " (matches the top-ranked candidate)" : " (differs from the top-ranked candidate)"}.`);
    console.log(`Recorded in ${decisionsPath(process.cwd())}`);
    return;
  }
  if (!["report", "dashboard", "compare"].includes(cmd)) throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);

  const prices = loadPricing(values.pricing);
  const costOf = (e: UsageEvent) => {
    const p = findPrice(e.model, prices);
    return p ? costUsd(e, p) : 0;
  };
  const load = async (from: Date, to: Date) => {
    // Only open log files touched since the start of the window.
    const [claude, codex] = await Promise.all([
      readClaudeUsage(values["claude-dir"], from),
      readCodexUsage(values["codex-dir"], from),
    ]);
    return inWindow([...claude, ...codex], from, to);
  };

  const lastDays = (fallback: number) => {
    const days = Number(values.days ?? fallback);
    if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
    const today = dayWindow(localDate());
    const from = new Date(today.from);
    from.setDate(from.getDate() - (days - 1));
    return { days, from, to: today.to };
  };

  let text: string;
  if (cmd === "compare") {
    const paths = values["worktrees-of"] ? listWorktrees(values["worktrees-of"]) : positionals.slice(1);
    if (paths.length < 2) throw new Error("compare needs at least two worktrees (pass paths or --worktrees-of <repo>)");
    const brief = values["brief-file"] ? readFileSync(values["brief-file"], "utf8") : values.brief;
    if (values.judge && !brief) throw new Error("--judge needs --brief or --brief-file: the judge scores attempts against the task.");
    const { from, to } = lastDays(30);
    const tasks = summarizeTasks(await load(from, to), gitResolver(), prices);
    const client = values.judge ? new Anthropic() : undefined;
    const orca = readOrcaWorkspaces(values["orca-db"]);
    const candidates: Candidate[] = [];
    for (const p of paths) {
      const worktree = gitResolver()(p).worktree;
      console.error(`Checking ${worktree}${values.test ? ` (running: ${values.test})` : ""}`);
      const c: Candidate = {
        worktree,
        name: orca.get(worktree)?.name,
        ...diffStats(p, values.base!),
        ...(values.test ? { test: runTests(p, values.test) } : {}),
        ...usageFor(worktree, tasks),
      };
      if (client && brief) {
        console.error(`Judging ${c.branch} with ${values.model ?? DEFAULT_JUDGE_MODEL}`);
        const testSummary = c.test ? (c.test.passed ? "passed" : `failed (exit ${c.test.exitCode}):\n${c.test.tail}`) : undefined;
        c.judge = await judgeAttempt(client, { brief, branch: c.branch, diff: fullDiff(p, values.base!), testSummary, model: values.model });
      }
      candidates.push(c);
    }
    const ranked = rankCandidates(candidates);
    saveComparison(process.cwd(), { comparedAt: new Date().toISOString(), base: values.base!, brief, test: values.test, candidates: ranked });
    text = values.json ? JSON.stringify({ base: values.base, test: values.test, candidates: ranked }, null, 2) : renderComparison(values.base!, ranked, values.test);
  } else if (cmd === "dashboard") {
    const { days, from, to } = lastDays(14);
    const events = await load(from, to);
    const tasks = summarizeTasks(events, gitResolver(), prices);
    attachNames(tasks, readOrcaWorkspaces(values["orca-db"]));
    text = renderDashboard({ from: localDate(from), to: localDate(), days: dailyStats(events, from, days, costOf), tasks });
    values.out ??= "reports/dashboard.html";
  } else {
    const date = values.date ?? localDate();
    const { from, to } = dayWindow(date);
    const events = await load(from, to);
    const tasks = summarizeTasks(events, gitResolver(), prices);
    for (const t of tasks) t.commits = commitsBetween(t.worktree, from, to);
    attachNames(tasks, readOrcaWorkspaces(values["orca-db"]));
    const report = buildReport(date, tasks, agentBreakdown(events, costOf));
    text = values.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  }

  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, text);
    console.error(`Wrote ${values.out}`);
  } else {
    console.log(text);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
