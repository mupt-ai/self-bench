-- A sandbox account's optional limit on image builds at once, apart from its sandboxes.
ALTER TABLE "credentials" ADD COLUMN "max_builds" integer;
