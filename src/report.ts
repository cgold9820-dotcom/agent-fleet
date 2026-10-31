import type { TaskSummary, UsageEvent } from "./types.js";
import { emptyTotals, totalTokens } from "./types.js";

export interface DailyReport {
  date: string;
  generatedAt: string;
  totals: ReturnType<typeof emptyTotals> & { costUsd: number; calls: number; tasks: number };
  byAgent: Record<string, { tokens: number; costUsd: number; calls: number }>;
  tasks: TaskSummary[];
}

/** Local-time [start, end) window for a YYYY-MM-DD date. */
export function dayWindow(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00`);
  if (Number.isNaN(from.getTime())) throw new Error(`Invalid date: ${date} (expected YYYY-MM-DD)`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function inWindow(events: UsageEvent[], from: Date, to: Date): UsageEvent[] {
  return events.filter((e) => {
    const t = new Date(e.timestamp);
    return t >= from && t < to;
  });
}

export function buildReport(date: string, tasks: TaskSummary[], perAgent: DailyReport["byAgent"]): DailyReport {
  const totals = { ...emptyTotals(), costUsd: 0, calls: 0, tasks: tasks.length };
  for (const t of tasks) {
    totals.inputTokens += t.inputTokens;
    totals.outputTokens += t.outputTokens;
    totals.cacheReadTokens += t.cacheReadTokens;
    totals.cacheWriteTokens += t.cacheWriteTokens;
    totals.costUsd += t.costUsd;
    totals.calls += t.calls;
  }
  return { date, generatedAt: new Date().toISOString(), totals, byAgent: perAgent, tasks };
}

export function agentBreakdown(events: UsageEvent[], costOf: (e: UsageEvent) => number): DailyReport["byAgent"] {
  const out: DailyReport["byAgent"] = {};
  for (const e of events) {
    const a = (out[e.agent] ??= { tokens: 0, costUsd: 0, calls: 0 });
    a.tokens += totalTokens(e);
    a.costUsd += costOf(e);
    a.calls++;
  }
  return out;
}

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtTime = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

export function renderMarkdown(r: DailyReport): string {
  const lines: string[] = [];
  const t = r.totals;
  lines.push(`# Agent fleet report: ${r.date}`, "");
  lines.push(
    `**${t.tasks} tasks** · **${fmtTokens(totalTokens(t))} tokens** · **${fmtUsd(t.costUsd)}** estimated · ${t.calls} model calls`,
    "",
  );
  if (r.tasks.length === 0) {
    lines.push("No agent activity recorded for this day.", "");
    return lines.join("\n");
  }

  lines.push("## By agent", "", "| Agent | Calls | Tokens | Est. cost |", "|---|---:|---:|---:|");
  for (const [agent, a] of Object.entries(r.byAgent).sort((x, y) => y[1].costUsd - x[1].costUsd)) {
    lines.push(`| ${agent} | ${a.calls} | ${fmtTokens(a.tokens)} | ${fmtUsd(a.costUsd)} |`);
  }
  lines.push("");

  lines.push(
    "## Tasks",
    "",
    "| Task | Repo | Branch | Agents | Active | Input | Output | Cache read | Est. cost | Commits |",
    "|---|---|---|---|---|---:|---:|---:|---:|---:|",
  );
  for (const k of r.tasks) {
    lines.push(
      `| ${k.name ?? "-"} | ${k.repo} | \`${k.branch}\` | ${k.agents.join(", ")} | ${fmtTime(k.firstSeen)}–${fmtTime(k.lastSeen)} | ${fmtTokens(
        k.inputTokens + k.cacheWriteTokens,
      )} | ${fmtTokens(k.outputTokens)} | ${fmtTokens(k.cacheReadTokens)} | ${fmtUsd(k.costUsd)} | ${k.commits.length} |`,
    );
  }
  lines.push("");

  const withCommits = r.tasks.filter((k) => k.commits.length > 0);
  if (withCommits.length) {
    lines.push("## What got done", "");
    for (const k of withCommits) {
      lines.push(`### ${k.name ? `${k.name} · ` : ""}${k.repo} · \`${k.branch}\``, "");
      for (const c of k.commits) lines.push(`- ${c}`);
      lines.push("");
    }
  }

  const unpriced = [...new Set(r.tasks.flatMap((k) => k.unpricedModels))];
  if (unpriced.length) {
    lines.push(`> Unpriced models (counted as $0): ${unpriced.join(", ")}. Add them with \`--pricing\`.`, "");
  }
  lines.push(
    "_Costs are list-price estimates from token counts; subscription plans are billed differently._",
    "",
  );
  return lines.join("\n");
}
