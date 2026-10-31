# agent-fleet

**Run coding agents like a team, and see what each one cost and delivered.**

`agent-fleet` is a local-first sidecar for people who run several coding agents in parallel
(for example with [Orca](https://github.com/stablyai/orca), where every agent gets its own git worktree).
It reads the logs your agents already write, maps every model call to the worktree and branch it ran in,
and turns that into per-task token and cost accounting plus a daily report.

- **Per-task accounting.** One task = one worktree + branch. Tokens (input, output, cache read/write) and estimated cost per task.
- **Multi-agent.** Claude Code and Codex today, normalized into one event model.
- **Orca-aware.** If [Orca](https://github.com/stablyai/orca) is installed, tasks are labeled with their workspace names (read-only, from Orca's profile database; needs Node 22.5+).
- **Dashboard.** A self-contained HTML page: cost per day by agent, and every task in the period.
- **Compare approaches.** Several worktrees attacking the same task, side by side: tests, diff size, tokens and cost, ranked so you can pick the winner.
- **LLM-as-judge.** Optionally, Claude scores each attempt's diff against the task brief (correctness, scope, quality, tests) with structured output.
- **Decision log.** `pick` records which attempt you chose and the metrics it was chosen on, building a dataset of which agents and strategies win.
- **Daily report.** Markdown or JSON: totals, per-agent split, per-task table, and the commits each task produced that day.
- **Local and private.** Reads files on your machine; nothing is uploaded.

## Quick start

```bash
git clone https://github.com/cgold9820-dotcom/agent-fleet && cd agent-fleet
npm install && npm run build
node dist/src/cli.js report                       # today, to stdout
node dist/src/cli.js report --date 2026-10-30 --out reports/2026-10-30.md
node dist/src/cli.js report --json                 # machine-readable
node dist/src/cli.js dashboard --days 14           # writes reports/dashboard.html
node dist/src/cli.js compare --worktrees-of ~/orca/projects/My-Book --test "npm test"
node dist/src/cli.js compare --worktrees-of ~/orca/projects/My-Book --test "npm test" \
  --judge --brief-file task.md                     # needs ANTHROPIC_API_KEY
node dist/src/cli.js pick feat/login-v2 --note "smaller diff, same coverage"
```

### How the judge works

Each attempt is reviewed in its **own** request, so candidate order cannot bias the scores. The judge sees the brief,
the test result (it is told not to guess) and the full diff, including uncommitted and untracked files.
Output is constrained to a schema (`correctness`, `scope`, `quality`, `tests` on 1–5, `overall` on 1–10, a summary and
concrete risks). Diffs over 400k characters are skipped rather than truncated, and refusals are reported as skipped.
Ranking: tests passed, then judge score, then cost, then diff size. Every `pick` is appended to
`.agent-fleet/decisions.jsonl`, including whether you agreed with the top-ranked candidate.

![Dashboard](docs/dashboard.png)

## How it works

```
~/.claude/projects/**/*.jsonl ─┐                 ┌─ git rev-parse (worktree, repo)
~/.codex/sessions/**/rollout-* ┼─► UsageEvent[] ─┼─► TaskSummary[] ─► daily report (md / json)
                               │   (normalized)  └─ pricing table      + git log per worktree
```

| Source | What we read | Notes |
|---|---|---|
| Claude Code | `assistant` records: `message.usage`, `cwd`, `gitBranch` | One response is split across records; deduped on `message.id + requestId` |
| Codex | `session_meta` (cwd, branch), `turn_context` (model), `token_count` | Totals are cumulative; we bill deltas. Cached tokens are split out of input |

Costs are **list-price estimates** (USD per 1M tokens, longest model-id prefix wins, cache read 0.1x and cache write 1.25x for Claude).
Subscription plans bill differently, so treat the number as a comparison metric. Override prices with `--pricing prices.json`:

```json
{ "my-custom-model": { "input": 1, "output": 4, "cacheRead": 0.1, "cacheWrite": 0 } }
```

Log locations respect `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, or pass `--claude-dir` / `--codex-dir`. Orca's database is found at its standard location per OS; override with `--orca-db` or `ORCA_PROFILE_DB`.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md): Cursor support, scheduled email digests.

## Development

```bash
npm test   # builds and runs node:test against fixtures in test/fixtures
```

## License

MIT
