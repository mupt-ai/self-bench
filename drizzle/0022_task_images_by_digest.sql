-- A task's images are now its two registry digests ({agent, verifier}). Rows whose images were
-- exported keep exactly that pair; provider-only records (Modal images, E2B templates, Daytona
-- snapshots, Vercel images that were never exported) are dropped, and those tasks build their
-- Dockerfiles until their images are rebuilt.
UPDATE "tasks"
SET "images" = CASE
  WHEN "images" -> 'registry' ->> 'agent' IS NOT NULL AND "images" -> 'registry' ->> 'verifier' IS NOT NULL
    THEN jsonb_build_object('agent', "images" -> 'registry' ->> 'agent', 'verifier', "images" -> 'registry' ->> 'verifier')
  ELSE NULL
END
WHERE "images" IS NOT NULL AND NOT ("images" ? 'agent' AND "images" ? 'verifier' AND NOT "images" ? 'provider');
