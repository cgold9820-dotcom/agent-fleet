# Changelog

## 0.4.0 (first packaged release, npm name `agent-fleet-cli`)
- Claude Code and Codex log parsers, per-worktree task accounting, cost estimates, daily Markdown/JSON report.
- `dashboard`: self-contained HTML page with cost per day by agent and a task table.
- `compare`: rank parallel attempts at one task by tests, judge score, cost and diff size; `--judge` adds LLM-as-judge scoring with structured output; `pick` records the human's choice.
- Orca workspace names in reports, dashboard and `compare`.
- `email` sends the daily report over SMTP; `schedule` sets it up in Task Scheduler or cron.
- Library entry point (`import { summarizeTasks } from "agent-fleet-cli"`) with type declarations.
- CI on Linux and Windows, Node 20 and 22.

Earlier milestones (v0.1 to v0.3 in docs/ROADMAP.md) were developed on main and not published separately.
