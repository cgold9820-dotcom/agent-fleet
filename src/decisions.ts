import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candidate } from "./compare.js";
import { normalizePath } from "./tasks.js";

export interface Comparison {
  comparedAt: string;
  base: string;
  brief?: string;
  test?: string;
  candidates: Candidate[];
}

export interface Decision {
  decidedAt: string;
  chosen: string;
  note?: string;
  /** Whether the human agreed with the tool's top-ranked candidate. */
  agreedWithRanking: boolean;
  comparison: Comparison;
}

const stateDir = (dir: string) => join(dir, ".agent-fleet");
const lastComparePath = (dir: string) => join(stateDir(dir), "last-compare.json");
export const decisionsPath = (dir: string) => join(stateDir(dir), "decisions.jsonl");

export function saveComparison(dir: string, c: Comparison): void {
  mkdirSync(stateDir(dir), { recursive: true });
  writeFileSync(lastComparePath(dir), JSON.stringify(c, null, 2));
}

/**
 * Record which candidate of the last comparison the human picked. Every pick,
 * with the metrics and judge scores it was made on, becomes one line of a
 * dataset: over time it shows which agents and strategies win, and how often
 * the ranking agrees with the human.
 */
export function recordDecision(dir: string, chosen: string, note?: string): Decision {
  if (!existsSync(lastComparePath(dir))) throw new Error("No comparison found here. Run `agent-fleet compare` first.");
  const comparison = JSON.parse(readFileSync(lastComparePath(dir), "utf8")) as Comparison;
  const match = comparison.candidates.find((c) => c.branch === chosen || c.worktree === normalizePath(chosen));
  if (!match) {
    throw new Error(`"${chosen}" was not in the last comparison. Candidates: ${comparison.candidates.map((c) => c.branch).join(", ")}`);
  }
  const decision: Decision = {
    decidedAt: new Date().toISOString(),
    chosen: match.branch,
    note,
    agreedWithRanking: comparison.candidates[0]?.branch === match.branch,
    comparison,
  };
  appendFileSync(decisionsPath(dir), JSON.stringify(decision) + "\n");
  return decision;
}
