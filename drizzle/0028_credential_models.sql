-- A custom endpoint's saved model IDs, offered on the Run page with the credential.
ALTER TABLE "credentials" ADD COLUMN "models" text[];
