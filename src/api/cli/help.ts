export function printHelp(): void {
  console.log(`SelfBench command-line access to the run API.

Usage:
  self-bench status RUN_ID
  self-bench cancel RUN_ID
  self-bench list
  self-bench download RUN_ID OUTPUT.tar.gz
  self-bench grant create --label NAME --task ID [--task ID ...] [--days N] [--with-verifier]
  self-bench grant list
  self-bench grant revoke GRANT_ID

Start runs from the web app or the /api routes. These commands call SELFBENCH_API_URL
(default http://127.0.0.1:8080) with SELFBENCH_API_TOKEN as the bearer token when it is set.
download verifies the export's SHA-256 before keeping the file.
grant issues a customer a registry login for accepted tasks' images (agent images only unless
--with-verifier, since the verifier images hold the tests). It needs the API token, prints the
password once, and expires after --days (default 30). revoke takes effect on the next pull.`);
}
