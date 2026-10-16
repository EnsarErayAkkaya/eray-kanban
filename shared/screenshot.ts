import { z } from 'zod';
import { SCREENSHOT_SIZES, type ScreenshotSize } from './project';

const SIZE_NAMES = Object.keys(SCREENSHOT_SIZES) as [ScreenshotSize, ...ScreenshotSize[]];

export const ScreenshotSchema = z.object({
  id: z.number().int().positive(),
  runId: z.number().int().positive(),
  route: z.string(),
  size: z.enum(SIZE_NAMES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Served at /api/screenshots/:id/image when true. */
  hasImage: z.boolean(),
  /** Why the page could not be captured, or a warning such as an HTTP error status. */
  error: z.string().nullable(),
  takenAt: z.iso.datetime(),
});
export type Screenshot = z.infer<typeof ScreenshotSchema>;
