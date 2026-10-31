# Changelog

## 0.4.0
- `email` sends the daily report over SMTP; `schedule` sets it up in Task Scheduler or cron.
- Orca workspace names in reports, dashboard and `compare`.
- `compare --judge`: LLM-as-judge scoring of each attempt's diff with structured output; `pick` records decisions.
- Library entry point (`import { summarizeTasks } from "agent-fleet"`) with type declarations.

## 0.3.0
- `compare`: rank parallel attempts at one task by tests, diff size, tokens and cost.
- CI on Linux and Windows, Node 20 and 22.

## 0.2.0
- `dashboard`: self-contained HTML page with cost per day by agent and a task table.

## 0.1.0
- Claude Code and Codex log parsers, per-worktree task accounting, cost estimates, daily Markdown/JSON report.
