-- Provider sign-ins (ChatGPT, Claude, Meta) no longer run: Connect with Dari replaced them. Each is
-- deleted as a user's Delete does, keeping the row for the runs and releases that name it and
-- erasing its tokens. So is a Dari connection saved one credential per plan kind, which only
-- preview builds made.
UPDATE "credentials" SET "deleted_at" = now(), "secret" = NULL
WHERE "deleted_at" IS NULL
  AND ("auth" IN ('codex-login', 'claude-login', 'muse-login')
    OR ("auth" = 'dari-link' AND "kind" <> 'dari-link'));
