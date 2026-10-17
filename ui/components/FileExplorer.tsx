import { useMemo, useState } from 'react';
import { type FileEntry, type TreeNode, buildTree, formatRef } from '../state/fileRefs';
import { PATH_DRAG_TYPE } from './MentionField';

interface Props {
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onPick: (path: string) => void;
  readonly onRefresh: () => void;
}

// A filter on a huge repo could match thousands of rows; past this, refining the filter is the way on.
const MAX_ROWS = 400;

interface Row {
  readonly node: TreeNode;
  readonly depth: number;
}

function visibleRows(nodes: readonly TreeNode[], open: ReadonlySet<string>, expandAll: boolean, depth = 0): Row[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.entry.kind === 'dir' && (expandAll || open.has(node.entry.path)) ? visibleRows(node.children, open, expandAll, depth + 1) : []),
  ]);
}

/** The project's files; click one to reference it in the field you last used, or drag it into a field. */
export function FileExplorer({ entries, truncated, loading, error, onPick, onRefresh }: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const tree = useMemo(() => buildTree(entries, filter), [entries, filter]);
  const rows = visibleRows(tree, open, filter.trim() !== '');

  const toggle = (path: string) => {
    const next = new Set(open);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpen(next);
  };

  return (
    <div className="explorer">
      <div className="explorer__bar">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter files"
          aria-label="Filter project files"
        />
        <button type="button" className="btn btn--small btn--ghost" onClick={onRefresh} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <p className="form-error">Could not list the files: {error}</p>}
      {loading && entries.length === 0 && <p className="hint">Listing files…</p>}
      {!loading && !error && entries.length === 0 && <p className="hint">This repo has no files git knows about yet.</p>}
      {rows.length > 0 && (
        <ul className="explorer__tree" role="tree">
          {rows.slice(0, MAX_ROWS).map(({ node, depth }) => {
            const { entry } = node;
            const isDir = entry.kind === 'dir';
            const expanded = isDir && (filter.trim() !== '' || open.has(entry.path));
            return (
              <li
                key={entry.path}
                role="treeitem"
                aria-expanded={isDir ? expanded : undefined}
                className="explorer__row"
                style={{ paddingLeft: `${depth * 14 + 4}px` }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(PATH_DRAG_TYPE, entry.path);
                  e.dataTransfer.setData('text/plain', `${formatRef(entry.path)} `);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                {isDir ? (
                  <button
                    type="button"
                    className="explorer__toggle"
                    onClick={() => toggle(entry.path)}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="explorer__toggle" aria-hidden="true" />
                )}
                <button
                  type="button"
                  className={`explorer__name${isDir ? ' explorer__name--dir' : ''}`}
                  onClick={() => onPick(entry.path)}
                  title={`Add ${formatRef(entry.path)}`}
                >
                  {entry.name}
                  {isDir ? '/' : ''}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > MAX_ROWS && <p className="hint">{rows.length - MAX_ROWS} more; narrow the filter to see them.</p>}
      {truncated && <p className="hint">This repo is very large, so only its first files are listed.</p>}
    </div>
  );
}
