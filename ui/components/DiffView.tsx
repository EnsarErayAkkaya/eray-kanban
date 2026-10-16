import type { FileDiffView } from '@shared/review';

const CHANGE_LABEL: Readonly<Record<FileDiffView['change'], string>> = { added: 'A', modified: 'M', deleted: 'D' };

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff__line diff__line--hunk';
  if (line.startsWith('+')) return 'diff__line diff__line--add';
  if (line.startsWith('-')) return 'diff__line diff__line--del';
  return 'diff__line';
}

// git's header lines repeat what the file row already says.
const isHeader = (line: string) => /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|old mode|new mode)/.test(line);

interface Props {
  readonly file: FileDiffView;
  readonly open: boolean;
}

export function DiffView({ file, open }: Props) {
  const lines = file.patch.split('\n').filter((l) => l !== '' && !isHeader(l));
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;

  return (
    <details className="diff" open={open}>
      <summary className="diff__file">
        <span className={`diff__change diff__change--${file.change}`}>{CHANGE_LABEL[file.change]}</span>
        <span className="diff__path">{file.path}</span>
        {!file.binary && (
          <span className="diff__stat">
            <span className="diff__plus">+{added}</span> <span className="diff__minus">−{removed}</span>
          </span>
        )}
      </summary>
      {file.binary ? (
        <p className="diff__note">Binary file, not shown.</p>
      ) : (
        <pre className="diff__body">
          {lines.map((line, i) => (
            <div key={i} className={lineClass(line)}>
              {line}
            </div>
          ))}
        </pre>
      )}
      {file.truncated && <p className="diff__note">Diff cut off at the size limit.</p>}
    </details>
  );
}
