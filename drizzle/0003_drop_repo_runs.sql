-- Batch generation also uses repo_runs for durable repository ownership.
-- Keep this migration slot for databases that already applied the review-page draft.
SELECT 1;
