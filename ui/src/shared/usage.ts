// Token usage of a call and what it costs on the API. Prices: USD per million tokens, Anthropic first-party rates.

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Dollars of the turns billed per token; Claude Code turns add none. */
  usd: number;
  /** Some turns went through a Claude Code subscription (no per-token price). */
  subscription: boolean;
}

export const emptyUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, subscription: false });

/** [input, output, cache read] per MTok, by model id prefix (longest first wins). */
const PRICES: [prefix: string, input: number, output: number, cacheRead: number][] = [
  ["claude-opus-5-5", 4, 20, 0.2],
  ["claude-opus-5", 5, 25, 0.5],
  ["claude-opus-4", 5, 25, 0.5],
  ["claude-sonnet-5-5", 2, 10, 0.1],
  ["claude-sonnet-5", 2, 10, 0.2],
  ["claude-sonnet-4", 3, 15, 0.3],
  // shortcut: Haiku 5.5 costs 5x more above 100K prompt tokens; our prompts stay far below that.
  ["claude-haiku-5-5", 0.1, 0.5, 0.01],
  ["claude-haiku-4", 1, 5, 0.1],
];

/** Dollars for one turn, or null for a model without a known price. */
export function turnCost(model: string, t: { input: number; cacheRead: number; cacheWrite: number; output: number }): number | null {
  const p = PRICES.filter(([prefix]) => model.startsWith(prefix)).sort((a, b) => b[0].length - a[0].length)[0];
  if (!p) return null;
  const [, input, output, cacheRead] = p;
  // shortcut: every cache write is priced at the 1-hour rate (2x input), an upper bound: the history's writes are 5-minute (1.25x).
  return (t.input * input + t.output * output + t.cacheRead * cacheRead + t.cacheWrite * input * 2) / 1e6;
}

/** Adds one turn's `usage` event to the running total. */
export function addTurn(u: Usage, e: { model: string; api: boolean; input: number; cache_read: number; cache_write: number; output: number }): Usage {
  const t = { input: e.input, cacheRead: e.cache_read, cacheWrite: e.cache_write, output: e.output };
  return {
    input: u.input + t.input,
    cacheRead: u.cacheRead + t.cacheRead,
    cacheWrite: u.cacheWrite + t.cacheWrite,
    output: u.output + t.output,
    usd: u.usd + (e.api ? (turnCost(e.model, t) ?? 0) : 0),
    subscription: u.subscription || !e.api,
  };
}
