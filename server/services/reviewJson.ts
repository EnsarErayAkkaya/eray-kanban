import { type ReviewJson, ReviewJsonSchema } from '@shared/review';

export type ReviewParse = { readonly ok: true; readonly review: ReviewJson } | { readonly ok: false; readonly error: string };

const FENCED_JSON = /```json\s*\n([\s\S]*?)\n\s*```/g;

// The prompt asks for the block at the end, so the last fenced json block wins.
export function extractReviewJson(finalMessage: string): ReviewParse {
  const blocks = [...finalMessage.matchAll(FENCED_JSON)].map((m) => m[1] ?? '');
  const candidate = blocks.at(-1) ?? finalMessage.trim();

  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    return { ok: false, error: blocks.length ? 'Review block is not valid JSON' : 'No review JSON block found' };
  }
  const parsed = ReviewJsonSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, review: parsed.data }
    : { ok: false, error: `Review JSON does not match the format: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
}
