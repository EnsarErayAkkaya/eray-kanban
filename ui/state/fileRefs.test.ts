import { describe, expect, it } from 'vitest';
import { buildEntries, buildTree, insertRef, matchDroppedName, mentionAt, searchEntries, splitRefs } from './fileRefs';

const entries = buildEntries([
  'README.md',
  'server/settings/store.ts',
  'ui/components/ProjectSettings.tsx',
  'ui/components/TaskForm.tsx',
  'ui/index.ts',
  'server/index.ts',
  'docs/my notes.md',
]);

describe('buildEntries', () => {
  it('adds every folder once, with a trailing slash', () => {
    const dirs = entries.filter((e) => e.kind === 'dir').map((e) => e.path);
    expect(dirs.sort()).toEqual(['docs/', 'server/', 'server/settings/', 'ui/', 'ui/components/']);
    expect(entries.find((e) => e.path === 'server/settings/')?.name).toBe('settings');
  });
});

describe('mentionAt', () => {
  it('finds the @word the caret is in', () => {
    expect(mentionAt('Fix @ui/comp', 12)).toEqual({ start: 4, query: 'ui/comp' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('see (@src', 9)).toEqual({ start: 5, query: 'src' });
  });

  it('ignores emails, finished words and text after a space', () => {
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(mentionAt('Fix @ui/x then', 14)).toBeNull();
    expect(mentionAt('no mention', 10)).toBeNull();
  });
});

describe('searchEntries', () => {
  it('ranks a name that starts with the query first, then names containing it, then paths', () => {
    expect(searchEntries(entries, 'set').map((e) => e.path)).toEqual([
      'server/settings/',
      'ui/components/ProjectSettings.tsx',
      'server/settings/store.ts',
    ]);
    expect(searchEntries(entries, 'index').map((e) => e.path)).toEqual(['ui/index.ts', 'server/index.ts']);
  });

  it('shows the top level, folders first, for an empty query', () => {
    expect(searchEntries(entries, '').map((e) => e.path)).toEqual(['docs/', 'server/', 'ui/', 'README.md']);
  });

  it('accepts backslashes typed on Windows', () => {
    expect(searchEntries(entries, 'ui\\comp')[0]?.path).toBe('ui/components/');
  });
});

describe('insertRef', () => {
  it('replaces the typed @query and leaves the caret after a space', () => {
    expect(insertRef('Fix @tas please', 4, 8, 'ui/components/TaskForm.tsx')).toEqual({
      text: 'Fix @ui/components/TaskForm.tsx  please',
      caret: 32,
    });
  });

  it('quotes a path with spaces, and adds a space before a reference glued to a word', () => {
    expect(insertRef('See', 3, 3, 'docs/my notes.md').text).toBe('See @"docs/my notes.md" ');
  });
});

describe('matchDroppedName', () => {
  it('finds files by name, ignoring case, and returns every candidate', () => {
    expect(matchDroppedName(entries, 'readme.MD')).toEqual(['README.md']);
    expect(matchDroppedName(entries, 'index.ts')).toEqual(['ui/index.ts', 'server/index.ts']);
    expect(matchDroppedName(entries, 'missing.ts')).toEqual([]);
  });
});

describe('splitRefs', () => {
  it('splits text into plain parts and references, leaving trailing punctuation outside', () => {
    expect(splitRefs('Fix @ui/index.ts, then @"docs/my notes.md". Mail a@b.c')).toEqual([
      { kind: 'text', text: 'Fix ' },
      { kind: 'ref', path: 'ui/index.ts' },
      { kind: 'text', text: ', then ' },
      { kind: 'ref', path: 'docs/my notes.md' },
      { kind: 'text', text: '. Mail a@b.c' },
    ]);
    expect(splitRefs('Folder @server/')).toEqual([
      { kind: 'text', text: 'Folder ' },
      { kind: 'ref', path: 'server/' },
    ]);
  });
});

describe('buildTree', () => {
  it('nests folders first, and keeps only matches and their folders when filtered', () => {
    const top = buildTree(entries).map((n) => n.entry.name);
    expect(top).toEqual(['docs', 'server', 'ui', 'README.md']);
    const filtered = buildTree(entries, 'taskform');
    expect(filtered.map((n) => n.entry.name)).toEqual(['ui']);
    expect(filtered[0]?.children[0]?.children.map((n) => n.entry.name)).toEqual(['TaskForm.tsx']);
  });
});
