# Trusted command runner, sourced by test.sh. The caller supplies kill_verifier_processes.
# Arguments: command, evidence mode (command|junit), expected JUnit identities as JSON.
run_verifier_command() {
  local command="$1" mode="$2" expected="$3"
  local logfile report_dir status attempt
  logfile="$(mktemp /tmp/selfbench-verifier-command-XXXXXX.log)" || return 2
  status=1
  for attempt in 1 2 3; do
    : > "$logfile"
    report_dir=""
    if [ "$mode" = junit ]; then
      report_dir="$(mktemp -d /tmp/selfbench-junit-XXXXXX)" || { rm -f "$logfile"; return 2; }
      chown verifier:verifier "$report_dir" || { rm -rf "$report_dir"; rm -f "$logfile"; return 2; }
      export SELFBENCH_JUNIT_REPORT="$report_dir/results.xml"
    fi
    runuser -u verifier --preserve-environment -- env -u XDG_CACHE_HOME HOME=/home/verifier bash -c "$command" >"$logfile" 2>&1
    status=$?
    kill_verifier_processes
    if [ "$status" -eq 0 ] || [ "$attempt" -eq 3 ] || ! grep -qE 'ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|META_FETCH_FAIL|FetchError|EPIPE|EPERM|registry\.npmjs' "$logfile"; then
      break
    fi
    [ -z "$report_dir" ] || rm -rf -- "$report_dir"
    sleep "$((10 * attempt))"
  done
  cat "$logfile"
  rm -f "$logfile"
  if [ "$mode" = junit ]; then
    runuser -u verifier --preserve-environment -- env HOME=/home/verifier python3 -I /opt/selfbench-runtime/junit.py "$SELFBENCH_JUNIT_REPORT" "$expected" "$status"
    status=$?
    rm -rf -- "$report_dir"
    unset SELFBENCH_JUNIT_REPORT
  fi
  return "$status"
}
