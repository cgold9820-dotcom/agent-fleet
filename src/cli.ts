#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { costUsd, findPrice, loadPricing } from "./pricing.js";
import { dailyStats, renderDashboard } from "./dashboard.js";
import { agentBreakdown, buildReport, dayWindow, inWindow, localDate, renderMarkdown } from "./report.js";
import { readClaudeUsage } from "./sources/claude.js";
import { readCodexUsage } from "./sources/codex.js";
import { commitsBetween, gitResolver, summarizeTasks } from "./tasks.js";
import type { UsageEvent } from "./types.js";

const HELP = `agent-fleet: token & cost accounting for parallel coding agents

Usage:
  agent-fleet report [--date YYYY-MM-DD] [--out FILE] [--json] [--pricing FILE]
  agent-fleet dashboard [--days 14] [--out reports/dashboard.html] [--pricing FILE]

Options:
  --date      Day to report on, local time (default: today)
  --days      Number of days the dashboard covers, ending today (default: 14)
  --out       Write the report to FILE instead of stdout
  --json      Emit JSON instead of Markdown
  --pricing   JSON file of per-model prices (USD per 1M tokens) to override defaults
  --claude-dir, --codex-dir   Override log locations

Reads Claude Code (~/.claude/projects) and Codex (~/.codex/sessions) logs locally.
Nothing leaves your machine.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      date: { type: "string" },
      days: { type: "string", default: "14" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      pricing: { type: "string" },
      "claude-dir": { type: "string" },
      "codex-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }
  if (cmd !== "report" && cmd !== "dashboard") throw new Error(`Unknown command: ${cmd}\n\n${HELP}`);

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

  let text: string;
  if (cmd === "dashboard") {
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 1) throw new Error(`--days must be a positive integer`);
    const today = dayWindow(localDate());
    const from = new Date(today.from);
    from.setDate(from.getDate() - (days - 1));
    const events = await load(from, today.to);
    const tasks = summarizeTasks(events, gitResolver(), prices);
    text = renderDashboard({ from: localDate(from), to: localDate(), days: dailyStats(events, from, days, costOf), tasks });
    values.out ??= "reports/dashboard.html";
  } else {
    const date = values.date ?? localDate();
    const { from, to } = dayWindow(date);
    const events = await load(from, to);
    const tasks = summarizeTasks(events, gitResolver(), prices);
    for (const t of tasks) t.commits = commitsBetween(t.worktree, from, to);
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
