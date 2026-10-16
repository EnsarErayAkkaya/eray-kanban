import type { CheckResult } from '@shared/check';

interface Props {
  readonly results: readonly CheckResult[];
}

function seconds(ms: number): string {
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function describe(result: CheckResult): string {
  if (result.passed) return 'passed';
  if (result.timedOut) return 'timed out';
  return result.exitCode === null ? 'did not finish' : `failed, exit ${result.exitCode}`;
}

export function ChecksView({ results }: Props) {
  return (
    <ul className="checks">
      {results.map((r, i) => (
        <li key={`${i}:${r.command}`} className={`checks__item checks__item--${r.passed ? 'pass' : 'fail'}`}>
          <details open={!r.passed}>
            <summary>
              <span className="checks__mark">{r.passed ? '✓' : '✗'}</span>
              <code>{r.command}</code>
              <span className="hint">
                {' '}
                · {describe(r)} · {seconds(r.durationMs)}
              </span>
            </summary>
            <pre className="checks__output">{r.output || 'No output.'}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
