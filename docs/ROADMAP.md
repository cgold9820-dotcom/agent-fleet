# Roadmap

The goal: a "manager's console" for a fleet of coding agents. Branch every task, try several approaches
in parallel, let evals and a human pick the winner, and know what every task cost.

## v0.1: accounting + daily report (done)
- [x] Claude Code and Codex log parsers, normalized `UsageEvent`
- [x] Task = git worktree + branch (works with Orca workspaces and plain `git worktree`)
- [x] Pricing table with prefix matching and overrides
- [x] Daily report in Markdown / JSON with per-task commits
- [x] Tests with fixtures, including a real linked-worktree case

## v0.2: dashboard
- [ ] `agent-fleet serve`: local web dashboard (tasks, cost over time, per-repo view)
- [ ] Read Orca's workspace metadata so tasks show their Orca names
- [ ] Cursor support (transcripts have no token counts: estimate from text length, flagged as estimated)

## v0.3: compare approaches
- [ ] `agent-fleet compare <task-group>`: for sibling worktrees attempting the same task, collect
      tests passed, lint, diff size, tokens and cost side by side
- [ ] Optional LLM-as-judge review of each diff against the task brief, with a rubric
- [ ] Record the human's pick to build a dataset of "which approach won and why"

## v0.4: delivery
- [ ] Scheduled daily digest by email (SMTP) and a static HTML report
- [ ] Weekly trends: cost per merged task, cache hit rate, agent win rates
