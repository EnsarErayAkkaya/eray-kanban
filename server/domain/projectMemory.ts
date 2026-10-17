import { MEMORY_LIMITS, type MemoryEntry, type MemoryEntryInput, type MemoryKind } from '@shared/memory';
import { ValidationError } from './errors';

// Relative to the repo root; committed with the project like any other file.
export const MEMORY_DIR = '.kanban';
export const MEMORY_FILES: Readonly<Record<MemoryKind, string>> = { decisions: 'decisions.md', knowhow: 'knowhow.md' };

// The agent reads these files as part of its system prompt, so the header tells it what they are.
const HEADERS: Readonly<Record<MemoryKind, string>> = {
  decisions: '# Project decisions\n\nChoices the user made for this project. Follow them unless the task says otherwise.',
  knowhow: '# Know-how\n\nThings learned in earlier tasks in this repo.',
};

const LINE = /^- (?:\[([^\]]+)\] )?(.+?)(?: \((?:#(\d+), )?(\d{4}-\d{2}-\d{2})\))?$/;

/** Reads the bullet lines and ignores everything else, so hand edits to the file survive. */
export function parseMemory(markdown: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const match = LINE.exec(raw.trim());
    if (!match) continue;
    const [, area, text, taskId, date] = match;
    entries.push({ area: area?.trim() ?? '', text: text ?? '', taskId: taskId ? Number(taskId) : null, date: date ?? null });
  }
  return entries;
}

export function renderEntry(entry: MemoryEntry): string {
  const source = [entry.taskId !== null && `#${entry.taskId}`, entry.date].filter(Boolean).join(', ');
  return `- ${entry.area ? `[${entry.area}] ` : ''}${entry.text}${source ? ` (${source})` : ''}`;
}

export function renderMemory(kind: MemoryKind, entries: readonly MemoryEntry[]): string {
  const body = entries.map(renderEntry).join('\n');
  return `${HEADERS[kind]}\n${body ? `\n${body}\n` : ''}`;
}

/** Stamps new entries with today's date and enforces the caps, so a file never outgrows its token budget. */
export function prepareEntries(kind: MemoryKind, input: readonly MemoryEntryInput[], today: string): MemoryEntry[] {
  const entries = input.map((e) => ({ ...e, date: e.date === undefined ? today : e.date }));
  const limit = MEMORY_LIMITS[kind];
  if (entries.length > limit.entries) throw new ValidationError(`${label(kind)} can hold at most ${limit.entries} entries`);
  const size = renderMemory(kind, entries).length;
  if (size > limit.chars) throw new ValidationError(`${label(kind)} is ${size} characters; the limit is ${limit.chars}`);
  return entries;
}

export function sameEntries(a: readonly MemoryEntry[], b: readonly MemoryEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => renderEntry(e) === renderEntry(b[i] as MemoryEntry));
}

function label(kind: MemoryKind): string {
  return kind === 'decisions' ? 'Decisions' : 'Know-how';
}
