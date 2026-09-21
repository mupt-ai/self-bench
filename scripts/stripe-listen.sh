#!/bin/sh
set -eu

secret_file=/run/selfbench-stripe/webhook-secret
rm -f "$secret_file"

stripe listen \
  --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted \
  --forward-to http://api:8080/api/stripe/webhook 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  secret=$(printf '%s\n' "$line" | sed -n 's/.*\(whsec_[A-Za-z0-9_-]*\).*/\1/p')
  if [ -n "$secret" ]; then
    printf '%s\n' "$secret" >"$secret_file.tmp"
    chmod 644 "$secret_file.tmp"
    mv "$secret_file.tmp" "$secret_file"
  fi
done

# A listener exits only on an error or shutdown. Make an unexpected exit restartable.
exit 1
