export function printHelp(): void {
  console.log(`SelfBench command-line access to the run API.

Usage:
  self-bench status RUN_ID
  self-bench cancel RUN_ID
  self-bench list
  self-bench download RUN_ID OUTPUT.tar.gz

Start runs from the web app or the /api routes. These commands call SELFBENCH_API_URL
(default http://127.0.0.1:8080) with SELFBENCH_API_TOKEN as the bearer token when it is set.
download verifies the export's SHA-256 before keeping the file.`);
}
