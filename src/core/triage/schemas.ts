import { z } from 'zod';

export const searchTermsSchema = z.object({ queries: z.array(z.string().trim().min(1)).min(1).max(3) });

export const assessSchema = z.object({
  duplicates: z.array(
    z.object({ identifier: z.string().min(1), confidence: z.number().min(0).max(1), reasoning: z.string() }),
  ),
});

export const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  problem: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
});
