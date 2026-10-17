import { describe, expect, it } from 'vitest';
import { MEMORY_LIMITS, type MemoryEntry } from '@shared/memory';
import { ValidationError } from './errors';
import { parseMemory, prepareEntries, renderMemory, sameEntries } from './projectMemory';

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({ area: 'tests', text: 'Run vitest with --pool=forks', taskId: 12, date: '2026-10-17', ...over });

describe('projectMemory', () => {
  it('round-trips entries through the file format', () => {
    const entries = [entry(), entry({ area: '', taskId: null, text: 'No new deps without asking' }), entry({ date: null, taskId: null })];
    expect(parseMemory(renderMemory('knowhow', entries))).toEqual(entries);
  });

  it('writes one line per entry under a header', () => {
    expect(renderMemory('decisions', [entry()])).toBe(
      '# Project decisions\n\nChoices the user made for this project. Follow them unless the task says otherwise.\n\n- [tests] Run vitest with --pool=forks (#12, 2026-10-17)\n',
    );
  });

  it('keeps parentheses that belong to the text', () => {
    const e = entry({ text: 'Dates look like (2026-01-01) in logs' });
    expect(parseMemory(renderMemory('knowhow', [e]))).toEqual([e]);
  });

  it('reads hand-written bullets and CRLF files, and skips other lines', () => {
    const file = '# Know-how\r\n\r\nSome prose.\r\n- [ui] Use the Sheet component\r\n  - nested? no\r\n* not ours\r\n- plain line\r\n';
    expect(parseMemory(file)).toEqual([
      { area: 'ui', text: 'Use the Sheet component', taskId: null, date: null },
      { area: '', text: 'nested? no', taskId: null, date: null },
      { area: '', text: 'plain line', taskId: null, date: null },
    ]);
  });

  it('stamps new entries with today and keeps existing dates', () => {
    const prepared = prepareEntries('knowhow', [{ area: '', text: 'a', taskId: null }, { area: '', text: 'b', taskId: null, date: null }], '2026-10-18');
    expect(prepared.map((e) => e.date)).toEqual(['2026-10-18', null]);
  });

  it('rejects more entries than the cap', () => {
    const many = Array.from({ length: MEMORY_LIMITS.decisions.entries + 1 }, (_, i) => entry({ text: `d${i}` }));
    expect(() => prepareEntries('decisions', many, '2026-10-18')).toThrow(ValidationError);
  });

  it('rejects a file larger than its character budget', () => {
    const long = Array.from({ length: 20 }, (_, i) => entry({ text: `${i} ${'x'.repeat(450)}` }));
    expect(() => prepareEntries('knowhow', long, '2026-10-18')).toThrow(/characters/);
  });

  it('compares entries by their rendered line', () => {
    expect(sameEntries([entry()], [entry()])).toBe(true);
    expect(sameEntries([entry()], [entry({ text: 'other' })])).toBe(false);
    expect(sameEntries([entry()], [])).toBe(false);
  });
});
