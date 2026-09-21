#!/bin/sh
set -eu

secret_file=/run/selfbench-stripe/webhook-secret
log_file=/tmp/stripe-listen.log
rm -f "$secret_file" "$log_file"

stripe listen --forward-to http://api:8080/api/stripe/webhook >"$log_file" 2>&1 &
stripe_pid=$!
tail_pid=

cleanup() {
  if [ -n "$tail_pid" ]; then kill "$tail_pid" 2>/dev/null || true; fi
  kill "$stripe_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

tail -n +1 -f "$log_file" | while IFS= read -r line; do
  printf '%s\n' "$line"
  secret=$(printf '%s\n' "$line" | sed -n 's/.*\(whsec_[A-Za-z0-9_-]*\).*/\1/p')
  if [ -n "$secret" ]; then
    printf '%s\n' "$secret" >"$secret_file.tmp"
    chmod 644 "$secret_file.tmp"
    mv "$secret_file.tmp" "$secret_file"
  fi
done &
tail_pid=$!

wait "$stripe_pid"
status=$?
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true
exit "$status"
