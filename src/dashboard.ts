import { totalTokens, type TaskSummary, type UsageEvent } from "./types.js";
import { localDate } from "./report.js";

export interface DayStat {
  date: string;
  byAgent: Record<string, number>;
  costUsd: number;
  tokens: number;
}

/** Bucket events into local-time days, filling gaps so the chart has no holes. */
export function dailyStats(events: UsageEvent[], from: Date, days: number, costOf: (e: UsageEvent) => number): DayStat[] {
  const stats = new Map<string, DayStat>();
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const key = localDate(d);
    stats.set(key, { date: key, byAgent: {}, costUsd: 0, tokens: 0 });
  }
  for (const e of events) {
    const s = stats.get(localDate(new Date(e.timestamp)));
    if (!s) continue;
    const c = costOf(e);
    s.byAgent[e.agent] = (s.byAgent[e.agent] ?? 0) + c;
    s.costUsd += c;
    s.tokens += totalTokens(e);
  }
  return [...stats.values()];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (n: number) => `$${n.toFixed(2)}`;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

const AGENT_COLORS: Record<string, string> = { "claude-code": "var(--c1)", codex: "var(--c2)" };

function chart(days: DayStat[]): string {
  const W = 760, H = 220, pad = { l: 48, r: 8, t: 12, b: 28 };
  const max = Math.max(0.01, ...days.map((d) => d.costUsd));
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const parts: string[] = [];
  for (const f of [0, 0.5, 1]) {
    const v = max * f;
    parts.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`);
    parts.push(`<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${usd(v)}</text>`);
  }
  days.forEach((d, i) => {
    let acc = 0;
    const x = pad.l + i * bw + bw * 0.15;
    for (const [agent, c] of Object.entries(d.byAgent)) {
      const top = y(acc + c);
      parts.push(
        `<rect x="${x}" y="${top}" width="${bw * 0.7}" height="${y(acc) - top}" fill="${AGENT_COLORS[agent] ?? "var(--muted)"}"><title>${d.date} ${esc(agent)}: ${usd(c)}</title></rect>`,
      );
      acc += c;
    }
    if (days.length <= 16 || i % Math.ceil(days.length / 14) === 0) {
      parts.push(`<text x="${x + bw * 0.35}" y="${H - 8}" text-anchor="middle">${d.date.slice(5)}</text>`);
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated cost per day">${parts.join("")}</svg>`;
}

export function renderDashboard(opts: { from: string; to: string; days: DayStat[]; tasks: TaskSummary[] }): string {
  const { days, tasks } = opts;
  const cost = days.reduce((a, d) => a + d.costUsd, 0);
  const tokens = days.reduce((a, d) => a + d.tokens, 0);
  const active = days.filter((d) => d.tokens > 0).length;
  const legend = Object.entries(AGENT_COLORS)
    .map(([a, c]) => `<span><i style="background:${c}"></i>${a}</span>`)
    .join("");
  const rows = tasks
    .map(
      (t) => `<tr><td>${esc(t.name ?? "-")}</td><td>${esc(t.repo)}</td><td><code>${esc(t.branch)}</code></td><td>${t.agents.join(", ")}</td><td>${t.sessions}</td><td class="n">${tok(
        totalTokens(t),
      )}</td><td class="n">${tok(t.cacheReadTokens)}</td><td class="n">${usd(t.costUsd)}</td><td>${t.lastSeen.slice(0, 10)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Fleet Dashboard</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--c1:#d97757;--c2:#3b82f6}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.kpi,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.kpi b{display:block;font-size:24px}.kpi span{color:var(--muted)}
svg{width:100%;height:auto}svg text{fill:var(--muted);font-size:11px}.grid{stroke:var(--line)}
.legend{display:flex;gap:16px;color:var(--muted);margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.table{overflow-x:auto;margin-top:20px}table{border-collapse:collapse;width:100%;min-width:640px}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}.n{text-align:right}
footer{color:var(--muted);font-size:12px;margin-top:20px}
</style></head><body><main>
<h1>Agent fleet</h1><p class="sub">${opts.from} to ${opts.to}</p>
<div class="kpis">
<div class="kpi"><b>${usd(cost)}</b><span>estimated cost</span></div>
<div class="kpi"><b>${tok(tokens)}</b><span>tokens</span></div>
<div class="kpi"><b>${tasks.length}</b><span>tasks (worktree + branch)</span></div>
<div class="kpi"><b>${active}/${days.length}</b><span>active days</span></div>
</div>
<div class="card">${chart(days)}<div class="legend">${legend}</div></div>
<div class="table card"><table><thead><tr><th>Task</th><th>Repo</th><th>Branch</th><th>Agents</th><th>Sessions</th><th class="n">Tokens</th><th class="n">Cache read</th><th class="n">Est. cost</th><th>Last active</th></tr></thead>
<tbody>${rows || `<tr><td colspan="9">No agent activity in this period.</td></tr>`}</tbody></table></div>
<footer>Generated by agent-fleet. Costs are list-price estimates from token counts.</footer>
</main></body></html>
`;
}
