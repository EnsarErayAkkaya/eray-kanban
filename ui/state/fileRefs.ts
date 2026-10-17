// @-references to repo files and folders in task text: finding, ranking, inserting and showing them.

export interface FileEntry {
  /** Repo-relative with / separators; folders end with /. */
  readonly path: string;
  readonly kind: 'file' | 'dir';
  /** Last segment, without the trailing / of a folder. */
  readonly name: string;
}

export function buildEntries(files: readonly string[]): FileEntry[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const entry = (p: string, kind: FileEntry['kind']): FileEntry => ({
    path: p,
    kind,
    name: p.replace(/\/$/, '').split('/').at(-1) ?? p,
  });
  return [...[...dirs].map((d) => entry(d, 'dir')), ...files.map((f) => entry(f, 'file'))];
}

/** The @word the caret is in, or null. An @ only counts at the start or after a space or bracket, so emails stay emails. */
export function mentionAt(text: string, caret: number): { readonly start: number; readonly query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s([{])@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

const depth = (p: string) => p.replace(/\/$/, '').split('/').length;

/** Best matches first: the name starting with the query, then the name containing it, then anywhere in the path. */
export function searchEntries(entries: readonly FileEntry[], query: string, limit = 8): FileEntry[] {
  const q = query.toLowerCase().replaceAll('\\', '/');
  if (q === '') {
    return entries
      .filter((e) => depth(e.path) === 1)
      .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1))
      .slice(0, limit);
  }
  const ranked: { entry: FileEntry; rank: number }[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const p = entry.path.toLowerCase();
    const rank = name.startsWith(q) ? 0 : name.includes(q) ? 1 : p.startsWith(q) ? 2 : p.includes(q) ? 3 : -1;
    if (rank >= 0) ranked.push({ entry, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((r) => r.entry);
}

/** Paths with spaces are quoted so the reference has a clear end. */
export function formatRef(p: string): string {
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

/** Replaces text[start, end) with the reference and a trailing space; returns the new text and caret. */
export function insertRef(text: string, start: number, end: number, p: string): { readonly text: string; readonly caret: number } {
  const ref = `${formatRef(p)} `;
  const before = text.slice(0, start);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  return { text: `${before}${lead}${ref}${text.slice(end)}`, caret: start + lead.length + ref.length };
}

/** Files in the project with this name. A browser drop gives only the name, never the path. */
export function matchDroppedName(entries: readonly FileEntry[], fileName: string): string[] {
  const name = fileName.toLowerCase();
  return entries.filter((e) => e.kind === 'file' && e.name.toLowerCase() === name).map((e) => e.path);
}

export type TextPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'ref'; readonly path: string };

export function splitRefs(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const pattern = /(^|[\s([{])@(?:"([^"\n]+)"|([^\s@"'`,;:!?)\]}]+[^\s@"'`,;:!?.)\]}]))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index + (match[1]?.length ?? 0);
    if (at > last) parts.push({ kind: 'text', text: text.slice(last, at) });
    parts.push({ kind: 'ref', path: match[2] ?? match[3] ?? '' });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

export interface TreeNode {
  readonly entry: FileEntry;
  readonly children: readonly TreeNode[];
}

/** Folders first, then files, each alphabetical; with a filter, only matches and the folders leading to them. */
export function buildTree(entries: readonly FileEntry[], filter = ''): TreeNode[] {
  const f = filter.trim().toLowerCase();
  const keep = new Set<string>();
  for (const e of entries) {
    if (f !== '' && !e.path.toLowerCase().includes(f)) continue;
    keep.add(e.path);
    const parts = e.path.replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) keep.add(`${parts.slice(0, i).join('/')}/`);
  }
  const byParent = new Map<string, FileEntry[]>();
  for (const e of entries) {
    if (!keep.has(e.path)) continue;
    const parent = e.path.replace(/\/$/, '').split('/').slice(0, -1).join('/');
    const key = parent === '' ? '' : `${parent}/`;
    byParent.set(key, [...(byParent.get(key) ?? []), e]);
  }
  const grow = (key: string): TreeNode[] =>
    (byParent.get(key) ?? [])
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
      .map((entry) => ({ entry, children: entry.kind === 'dir' ? grow(entry.path) : [] }));
  return grow('');
}
