run_verifier_command() {
  local command="$1" mode="$2" expected="$3"
  local report_dir="" status

  if [ "$mode" = junit ]; then
    report_dir="$(mktemp -d /tmp/selfbench-junit-XXXXXX)" || return 2
    chown verifier:verifier "$report_dir" || { rm -rf "$report_dir"; return 2; }
    export SELFBENCH_JUNIT_REPORT="$report_dir/results.xml"
  fi

  runuser -u verifier --preserve-environment -- env \
    -u XDG_CACHE_HOME HOME=/home/verifier bash -c "$command"
  status=$?
  kill_verifier_processes

  if [ "$mode" = junit ]; then
    runuser -u verifier --preserve-environment -- env HOME=/home/verifier \
      python3 -I /opt/selfbench-runtime/junit.py \
      "$SELFBENCH_JUNIT_REPORT" "$expected" "$status"
    status=$?
    rm -rf "$report_dir"
    unset SELFBENCH_JUNIT_REPORT
  fi

  return "$status"
}
