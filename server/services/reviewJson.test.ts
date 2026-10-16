import { describe, expect, it } from 'vitest';
import { extractReviewJson } from './reviewJson';

const fence = (json: string) => '```json\n' + json + '\n```';

describe('extractReviewJson', () => {
  it('reads the block at the end of the final message', () => {
    const message = `I added the page.\n\n${fence('{"outcome": "done", "summary": "Added /settings"}')}`;
    expect(extractReviewJson(message)).toEqual({
      ok: true,
      review: { outcome: 'done', summary: 'Added /settings', notes: [], concerns: [] },
    });
  });

  it('takes the last block when there are several', () => {
    const message = [
      fence('{"example": true}'),
      'Done.',
      fence('{"outcome": "needs_input", "question": "Which email provider?"}'),
    ].join('\n');
    expect(extractReviewJson(message)).toMatchObject({ ok: true, review: { outcome: 'needs_input' } });
  });

  it('keeps the review when its routes are malformed, keeping only the strings', () => {
    const parse = (routes: unknown) => extractReviewJson(JSON.stringify({ outcome: 'done', summary: 'x', routes }));
    expect(parse(['/a', 3, null, '/b'])).toMatchObject({ ok: true, review: { routes: ['/a', '/b'] } });
    expect(parse('/a')).toMatchObject({ ok: true, review: { routes: [] } });
  });

  it('accepts a bare JSON message', () => {
    expect(extractReviewJson('{"outcome":"done","summary":"ok"}')).toMatchObject({ ok: true });
  });

  it('explains what is wrong', () => {
    expect(extractReviewJson('All done!')).toEqual({ ok: false, error: 'No review JSON block found' });
    expect(extractReviewJson(fence('{"outcome": "done",'))).toEqual({ ok: false, error: 'Review block is not valid JSON' });
    expect(extractReviewJson(fence('{"outcome": "done"}'))).toMatchObject({ ok: false });
  });
});
