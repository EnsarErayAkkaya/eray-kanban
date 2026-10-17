import { splitRefs } from '../state/fileRefs';

const shortName = (p: string) => {
  const folder = p.endsWith('/');
  const name = p.replace(/\/$/, '').split('/').at(-1) ?? p;
  return folder ? `${name}/` : name;
};

/** Task text with its @file and @folder references shown as code chips; compact shows only the last name. */
export function RefText({ text, compact = false }: { readonly text: string; readonly compact?: boolean }) {
  return (
    <>
      {splitRefs(text).map((part, i) =>
        part.kind === 'ref' ? (
          <code key={i} className="ref" title={part.path}>
            {compact ? shortName(part.path) : part.path}
          </code>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
