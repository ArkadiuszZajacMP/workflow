#!/usr/bin/env bash
# Runs a command with secrets resolved from 1Password, without writing them to disk.
# Reads KEY=VALUE lines from .env.op (or $WORKFLOW_ENV_OP). Values starting with op:// are
# resolved with `op read`; other values are passed through. Uses `op read` rather than `op run`
# so it also works with the Windows op.exe from WSL (op run would start the command on Windows).
set -euo pipefail

env_file="${WORKFLOW_ENV_OP:-.env.op}"
if [[ ! -f "$env_file" ]]; then
  echo "with-secrets: $env_file not found. Copy .env.op.example to $env_file and set your op:// references." >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  if [[ "$value" == op://* ]]; then
    if ! value="$(op read "$value" </dev/null)"; then
      echo "with-secrets: could not read $key from 1Password (signed in? reference correct?)" >&2
      exit 1
    fi
    value="${value%$'\r'}"
  fi
  export "$key=$value"
done < "$env_file"

exec "$@"
