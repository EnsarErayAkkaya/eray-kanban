import { z } from 'zod';

export const MODELS = ['sonnet', 'opus', 'haiku'] as const;
export const ModelSchema = z.enum(MODELS);
export type Model = z.infer<typeof ModelSchema>;

export const IdSchema = z.coerce.number().int().positive();
export const TimestampSchema = z.iso.datetime();
export const TurnLimitSchema = z.number().int().min(1).max(500);
