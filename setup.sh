#!/bin/sh
set -eu
umask 077

base_url="${PUSHME_BOT_URL:-https://pushme.site}"
env_file="${NETNODE_ENV_FILE:-/data/netnode.env}"
org_name="${PUSHME_SETUP_ORG_NAME:-$(hostname)-netnode}"
location="${PUSHME_SETUP_LOCATION:-$(hostname)-netnode}"
description="${PUSHME_SETUP_DESCRIPTION:-Publishes connectivity events from pushme-netnode into PushMe.}"
website_url="${PUSHME_SETUP_WEBSITE_URL:-https://pushme.site/netnode}"
tab="$(printf '\t')"

case "$base_url" in
  https://*|http://127.0.0.1:*|http://localhost:*|http://[::1]:*)
    ;;
  *)
    echo "[pushme-netnode] unsupported PUSHME_BOT_URL: ${base_url}" >&2
    exit 1
    ;;
esac

if [ -n "${PUSHME_API_KEY:-}" ]; then
  exit 0
fi

tmp_response="$(mktemp)"
trap 'rm -f "$tmp_response"' EXIT INT TERM

payload=$(
  cat <<EOF
{"orgName":"$(printf '%s' "$org_name" | sed 's/\\/\\\\/g; s/"/\\"/g')","role":"publisher","description":"$(printf '%s' "$description" | sed 's/\\/\\\\/g; s/"/\\"/g')","websiteUrl":"$(printf '%s' "$website_url" | sed 's/\\/\\\\/g; s/"/\\"/g')"}
EOF
)

curl -fsS \
  -H 'content-type: application/json' \
  -d "$payload" \
  "$base_url/api/bot/register" >"$tmp_response"

api_key="$(sed -n 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp_response" | head -n 1)"

if [ -z "$api_key" ]; then
  echo "[pushme-netnode] setup failed: apiKey missing" >&2
  cat "$tmp_response" >&2
  exit 1
fi

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_response" "$tmp_env"' EXIT INT TERM
chmod 600 "$tmp_env"
{
  printf 'PUSHME_API_KEY%s%s\n' "$tab" "$api_key"
  printf 'PUSHME_BOT_URL%s%s\n' "$tab" "$base_url"
  printf 'NETNODE_LOCATION%s%s\n' "$tab" "$location"
} >"$tmp_env"
mv "$tmp_env" "$env_file"

echo "[pushme-netnode] wrote ${env_file}" >&2
