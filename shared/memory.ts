import { z } from 'zod';
import { IdSchema } from './common';

export const MEMORY_KINDS = ['decisions', 'knowhow'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

// Both files load into every agent run, so the caps are the token budget.
export const MEMORY_LIMITS: Readonly<Record<MemoryKind, { readonly entries: number; readonly chars: number }>> = {
  decisions: { entries: 30, chars: 6_000 },
  knowhow: { entries: 40, chars: 6_000 },
};

const oneLine = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max));

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const MemoryEntrySchema = z.object({
  area: oneLine(40).pipe(z.string().regex(/^[^[\]]*$/, 'Area cannot contain [ or ]')),
  text: oneLine(500).pipe(z.string().min(1)),
  /** The task it came from; null when you wrote it by hand. */
  taskId: IdSchema.nullable(),
  /** null for a hand-written line in the file that has no date. */
  date: DateSchema.nullable(),
});
export type MemoryEntry = z.output<typeof MemoryEntrySchema>;

/** What an agent proposes in its review JSON; only know-how, since decisions are yours. */
export const LessonSchema = z.object({ area: MemoryEntrySchema.shape.area.default(''), text: MemoryEntrySchema.shape.text });
export type Lesson = z.output<typeof LessonSchema>;
export const MAX_LESSONS = 5;

export const ProjectMemorySchema = z.object({
  decisions: z.array(MemoryEntrySchema),
  knowhow: z.array(MemoryEntrySchema),
});
export type ProjectMemory = z.output<typeof ProjectMemorySchema>;

// A new entry has no date yet; the server stamps it.
const EntryInput = MemoryEntrySchema.extend({
  area: MemoryEntrySchema.shape.area.default(''),
  taskId: MemoryEntrySchema.shape.taskId.default(null),
  date: MemoryEntrySchema.shape.date.optional(),
}).strict();
export type MemoryEntryInput = z.output<typeof EntryInput>;

export const UpdateMemoryInput = z
  .object({
    decisions: z.array(EntryInput).max(MEMORY_LIMITS.decisions.entries),
    knowhow: z.array(EntryInput).max(MEMORY_LIMITS.knowhow.entries),
  })
  .strict();
export type MemoryUpdate = z.output<typeof UpdateMemoryInput>;
