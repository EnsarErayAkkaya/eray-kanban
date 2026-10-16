import type { UsageTotals } from '../state/boardState';

const count = (n: number) => n.toLocaleString('en-US');

export function UsageSummary({ totals }: { readonly totals: UsageTotals }) {
  if (totals.runs === 0) return null;
  const tokens = [
    `${count(totals.inputTokens)} input`,
    `${count(totals.outputTokens)} output`,
    `${count(totals.cacheCreationTokens)} cache write`,
    `${count(totals.cacheReadTokens)} cache read`,
  ].join(' · ');
  return (
    <span className="usage" title={`Tokens: ${tokens}`}>
      ${totals.costUsd.toFixed(2)} · {count(totals.numTurns)} turns · {count(totals.runs)} runs
    </span>
  );
}
