import { z } from "zod";
import { githubRepository } from "../github.js";

export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/i, "expected a full commit SHA");

export const repositoryRefSchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((url) => isGitHubRepository(url), "expected a GitHub repository URL"),
    commit: commitSchema,
  })
  .strict();

export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

export const artifactRefSchema = z.object({
  uri: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const difficultySchema = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof difficultySchema>;

export function isGitHubRepository(value: string): boolean {
  try {
    githubRepository(value);
    return true;
  } catch {
    return false;
  }
}
