import { z } from "zod";

export const teamSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  current: z.boolean().optional(),
});

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const vcrTagSchema = z.object({
  tag: z.string().min(1),
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  kind: z.enum(["manifest", "index"]).optional(),
  status: z.string().min(1).nullable(),
});

export type VercelTeam = z.infer<typeof teamSchema>;
export type VercelProject = z.infer<typeof projectSchema>;
export type VcrTag = z.infer<typeof vcrTagSchema>;
