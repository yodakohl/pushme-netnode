#!/bin/sh
set -eu
umask 077

env_file="${NETNODE_ENV_FILE:-/data/netnode.env}"
tab="$(printf '\t')"
existing_api_key=""

if [ -f "$env_file" ]; then
  existing_api_key="$(awk -F "$tab" '$1=="PUSHME_API_KEY"{print $2; exit}' "$env_file" 2>/dev/null || true)"
fi

if [ "${PUSHME_AUTO_SETUP:-0}" = "1" ] && [ -z "${PUSHME_API_KEY:-${existing_api_key:-}}" ]; then
  sh ./setup.sh
fi

exec "$@"
