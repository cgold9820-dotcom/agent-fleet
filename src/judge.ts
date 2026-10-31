import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const DEFAULT_JUDGE_MODEL = "claude-opus-5-5";

/** Diffs larger than this are not judged rather than silently truncated. */
export const MAX_DIFF_CHARS = 400_000;

export const JudgeScoreSchema = z.object({
  correctness: z.number().int().min(1).max(5).describe("Does the change do what the brief asks, without bugs?"),
  scope: z.number().int().min(1).max(5).describe("Does it stay within the brief, without unrelated changes?"),
  quality: z.number().int().min(1).max(5).describe("Readability, structure, fit with the surrounding code."),
  tests: z.number().int().min(1).max(5).describe("Are the changes covered by meaningful tests?"),
  overall: z.number().int().min(1).max(10),
  summary: z.string().describe("Two or three sentences a manager can read."),
  risks: z.array(z.string()).describe("Concrete problems a reviewer should check; empty if none."),
});

export type JudgeScore = z.infer<typeof JudgeScoreSchema>;

export type JudgeResult = { status: "scored"; model: string; score: JudgeScore } | { status: "skipped"; reason: string };

/** The slice of the Anthropic client the judge uses, so tests can pass a fake. */
export interface JudgeClient {
  messages: Pick<Anthropic["messages"], "parse">;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });

/** Full diff of the working tree against the merge base, including new untracked files. */
export function fullDiff(worktree: string, base: string): string {
  const mergeBase = git(worktree, "merge-base", base, "HEAD").trim();
  let diff = git(worktree, "diff", mergeBase);
  const untracked = git(worktree, "ls-files", "--others", "--exclude-standard").split(/\r?\n/).filter(Boolean);
  for (const file of untracked) {
    let content: string;
    try {
      content = readFileSync(join(worktree, file), "utf8");
    } catch {
      continue;
    }
    diff += `\n--- /dev/null\n+++ b/${file}\n${content
      .split("\n")
      .map((l) => `+${l}`)
      .join("\n")}\n`;
  }
  return diff;
}

const SYSTEM = `You review one attempt by a coding agent at a task. Several agents attempted the same task in parallel git worktrees; a human will pick one, and your review helps them decide.

Score only what the diff shows. Judge correctness against the brief first: a small diff that solves the task beats a large one that adds unrequested features. Name concrete risks a reviewer should check (with file names), not general advice. Test results are given to you; do not guess whether tests pass.`;

export function judgePrompt(brief: string, branch: string, diff: string, testSummary?: string): string {
  return [
    `<brief>\n${brief}\n</brief>`,
    `<attempt branch="${branch}">`,
    testSummary ? `<test_result>${testSummary}</test_result>` : "<test_result>not run</test_result>",
    `<diff>\n${diff}\n</diff>`,
    `</attempt>`,
  ].join("\n");
}

/**
 * Ask Claude to score one attempt. Each attempt is judged in its own request
 * so the order of candidates cannot bias the scores.
 */
export async function judgeAttempt(
  client: JudgeClient,
  opts: { brief: string; branch: string; diff: string; testSummary?: string; model?: string },
): Promise<JudgeResult> {
  if (!opts.diff.trim()) return { status: "skipped", reason: "no changes" };
  if (opts.diff.length > MAX_DIFF_CHARS) {
    return { status: "skipped", reason: `diff is ${opts.diff.length} chars, over the ${MAX_DIFF_CHARS} limit` };
  }
  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium", format: zodOutputFormat(JudgeScoreSchema) },
    messages: [{ role: "user", content: judgePrompt(opts.brief, opts.branch, opts.diff, opts.testSummary) }],
  });
  if (response.stop_reason === "refusal") return { status: "skipped", reason: "the model declined to review this diff" };
  if (!response.parsed_output) return { status: "skipped", reason: `no structured output (stop_reason: ${response.stop_reason})` };
  return { status: "scored", model, score: response.parsed_output };
}
