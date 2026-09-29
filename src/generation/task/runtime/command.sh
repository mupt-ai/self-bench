run_verifier_command() {
  local command="$1" status

  runuser -u verifier --preserve-environment -- env \
    -u XDG_CACHE_HOME HOME=/home/verifier bash -c "$command"
  status=$?
  kill_verifier_processes
  return "$status"
}
