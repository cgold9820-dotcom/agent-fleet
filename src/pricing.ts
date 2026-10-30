import { existsSync, readFileSync } from "node:fs";
import type { TokenTotals } from "./types.js";

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const claude = (input: number, output: number): ModelPrice => ({
  input,
  output,
  cacheRead: input * 0.1,
  cacheWrite: input * 1.25,
});
const openai = (input: number, output: number, cacheRead: number): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});

/**
 * Default list prices, matched by model-id prefix (longest prefix wins).
 * These are estimates for comparison, not invoices: subscription plans bill
 * differently. Override or extend with a JSON file (see loadPricing).
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": claude(10, 50),
  "claude-opus-5-5": claude(4, 20),
  "claude-opus-5": claude(5, 25),
  "claude-opus-4-5": claude(5, 25),
  "claude-opus-4-6": claude(5, 25),
  "claude-opus-4-7": claude(5, 25),
  "claude-opus-4-8": claude(5, 25),
  "claude-opus-4": claude(15, 75),
  "claude-sonnet-5": claude(2, 10),
  "claude-sonnet-4": claude(3, 15),
  "claude-haiku-5-5": claude(0.1, 0.5),
  "claude-haiku-4": claude(1, 5),
  "claude-3-5-haiku": claude(0.8, 4),
  "gpt-5": openai(1.25, 10, 0.125),
  "gpt-5-mini": openai(0.25, 2, 0.025),
  "o4-mini": openai(1.1, 4.4, 0.275),
};

export function loadPricing(file?: string): Record<string, ModelPrice> {
  if (!file || !existsSync(file)) return DEFAULT_PRICES;
  const overrides = JSON.parse(readFileSync(file, "utf8")) as Record<string, ModelPrice>;
  return { ...DEFAULT_PRICES, ...overrides };
}

export function findPrice(model: string, prices = DEFAULT_PRICES): ModelPrice | undefined {
  let best: string | undefined;
  for (const prefix of Object.keys(prices)) {
    if (model.startsWith(prefix) && (!best || prefix.length > best.length)) best = prefix;
  }
  return best ? prices[best] : undefined;
}

export function costUsd(t: TokenTotals, price: ModelPrice): number {
  return (
    (t.inputTokens * price.input +
      t.outputTokens * price.output +
      t.cacheReadTokens * price.cacheRead +
      t.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}
