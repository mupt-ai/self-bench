-- ChatGPT sign-ins without a limit get the new default (CHATGPT_SIGN_IN_MAX_SANDBOXES): one
-- subscription answered most of a 113-trial evaluation with 429s once every trial called it at once.
UPDATE "credentials" SET "max_sandboxes" = 50 WHERE "auth" = 'codex-login' AND "max_sandboxes" IS NULL AND "deleted_at" IS NULL;
