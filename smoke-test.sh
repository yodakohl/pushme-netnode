#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
pushme_repo_root="${PUSHME_REPO_ROOT:-/home/PushMe}"
tab="$(printf '\t')"
image_tag="${PUSHME_NETNODE_TEST_IMAGE:-pushme-netnode-smoketest}"
host_base_url="${PUSHME_BOT_URL:-}"
container_base_url="${host_base_url:-}"
work_dir="$(mktemp -d)"
run_id="$(date +%s)-$$"
org_name="pushme-netnode-smoketest-${run_id}"
location_name="${org_name}"
data_volume="pushme-netnode-smoke-${run_id}"
mock_container_name="pushme-netnode-smoke-mock-${run_id}"
network_name="pushme-netnode-smoke-net-${run_id}"
using_mock=0
cleanup_done=0

# shellcheck disable=SC1091
. "${script_dir}/test/testlib.sh"

if [ -z "$host_base_url" ]; then
  using_mock=1
  start_mock_pushme "$script_dir" "$mock_container_name" "$network_name"
  host_base_url="$MOCK_PUSHME_HOST_URL"
  container_base_url="$MOCK_PUSHME_CONTAINER_URL"
fi

cleanup() {
  [ "$cleanup_done" -eq 1 ] && return 0
  cleanup_done=1
  if [ "${KEEP_SMOKETEST_ARTIFACTS:-0}" = "1" ]; then
    if [ "$using_mock" -eq 1 ]; then
      echo "[pushme-netnode smoke-test] keeping artifacts in ${work_dir}, volume ${data_volume}, mock ${mock_container_name}, network ${network_name} for ${org_name}" >&2
    else
      echo "[pushme-netnode smoke-test] keeping artifacts in ${work_dir}, volume ${data_volume} for ${org_name}" >&2
    fi
    return 0
  fi
  if [ "$using_mock" -eq 1 ]; then
    cleanup_mock_pushme "$mock_container_name" "$network_name"
  else
    cleanup_org_from_database "$pushme_repo_root" "$org_name"
  fi
  docker volume rm "$data_volume" >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}

trap cleanup EXIT INT TERM

docker build -t "$image_tag" "$script_dir" >/dev/null
docker volume create "$data_volume" >/dev/null

set -- docker run --rm
[ "$using_mock" -eq 1 ] && set -- "$@" --network "$network_name"
[ "$using_mock" -eq 1 ] && set -- "$@" -e NETNODE_ALLOW_HTTP_BASE_URLS="$container_base_url"
set -- "$@" \
  -e PUSHME_AUTO_SETUP=1 \
  -e PUSHME_BOT_URL="$container_base_url" \
  -e PUSHME_SETUP_ORG_NAME="$org_name" \
  -e PUSHME_SETUP_LOCATION="$location_name" \
  -e NETNODE_COUNTRY=Germany \
  -e NETNODE_PROVIDER=DigitalOcean \
  -e NETNODE_ASN=14061 \
  -e NETNODE_NETWORK_TYPE=cloud \
  -e NETNODE_PUBLISH_MODE=always \
  -v "${data_volume}:/data" \
  "$image_tag" sh ./netnode.sh --once
"$@" >/tmp/pushme-netnode-smoke-first.json

docker run --rm --entrypoint sh -v "${data_volume}:/data" "$image_tag" -lc 'cat /data/netnode.env' >"${work_dir}/netnode.env"
docker run --rm --entrypoint sh -v "${data_volume}:/data" "$image_tag" -lc 'cat /data/netnode-state.tsv' >"${work_dir}/netnode-state.tsv"

[ -s "${work_dir}/netnode.env" ]
[ -s "${work_dir}/netnode-state.tsv" ]

PUSHME_API_KEY="$(awk -F "$tab" '$1=="PUSHME_API_KEY"{print $2; exit}' "${work_dir}/netnode.env")"
[ -n "${PUSHME_API_KEY:-}" ]

status_json=''
status_attempt=0
while [ "$status_attempt" -lt 5 ]; do
  status_json="$(curl -fsS -H "authorization: Bearer ${PUSHME_API_KEY}" "${host_base_url}/api/bot/netnode/status")"
  if printf '%s' "$status_json" | jq -e '.runtime.nodeVersion | length > 0' >/dev/null &&
    printf '%s' "$status_json" | jq -e '.runtime.lastSeenAt != null and .runtime.onlineNow == true' >/dev/null &&
    printf '%s' "$status_json" | jq -e '.recentNodeEvents | length >= 1' >/dev/null; then
    break
  fi
  status_attempt=$((status_attempt + 1))
  sleep 2
done

if ! printf '%s' "$status_json" | jq -e '.runtime.nodeVersion | length > 0' >/dev/null; then
  echo "[pushme-netnode smoke-test] status payload missing runtime nodeVersion" >&2
  printf '%s\n' "$status_json" >&2
  exit 1
fi
if ! printf '%s' "$status_json" | jq -e '.runtime.lastSeenAt != null and .runtime.onlineNow == true' >/dev/null; then
  echo "[pushme-netnode smoke-test] status payload missing live heartbeat state" >&2
  printf '%s\n' "$status_json" >&2
  exit 1
fi
if ! printf '%s' "$status_json" | jq -e '.recentNodeEvents | length >= 1' >/dev/null; then
  echo "[pushme-netnode smoke-test] status payload missing recent node events" >&2
  printf '%s\n' "$status_json" >&2
  exit 1
fi

set -- docker run --rm
[ "$using_mock" -eq 1 ] && set -- "$@" --network "$network_name"
[ "$using_mock" -eq 1 ] && set -- "$@" -e NETNODE_ALLOW_HTTP_BASE_URLS="$container_base_url"
set -- "$@" \
  -e PUSHME_BOT_URL="$container_base_url" \
  -e PUSHME_API_KEY="$PUSHME_API_KEY" \
  -e NETNODE_LOCATION="$location_name" \
  -e NETNODE_COUNTRY=Germany \
  -e NETNODE_PROVIDER=DigitalOcean \
  -e NETNODE_ASN=14061 \
  -e NETNODE_NETWORK_TYPE=cloud \
  -e NETNODE_PUBLISH_MODE=changes \
  -v "${data_volume}:/data" \
  "$image_tag" sh ./netnode.sh --once
"$@" >/tmp/pushme-netnode-smoke-second.json

jq -se 'last | (.skipped == true or ((.eventType // "") | startswith("net.")))' /tmp/pushme-netnode-smoke-second.json >/dev/null

printf '{\n'
printf '  "image": "%s",\n' "$image_tag"
printf '  "orgName": "%s",\n' "$org_name"
printf '  "statusVerified": true,\n'
printf '  "runtimeNodeVersion": %s,\n' "$(printf '%s' "$status_json" | jq -c '.runtime.nodeVersion')"
printf '  "runtimeImage": %s,\n' "$(printf '%s' "$status_json" | jq -c '.runtime.image')"
printf '  "recentEventCount": %s,\n' "$(printf '%s' "$status_json" | jq -r '.recentNodeEvents | length')"
printf '  "stateFile": %s,\n' "$(jq -Rs . < "${work_dir}/netnode-state.tsv")"
printf '  "secondRunResult": %s\n' "$(jq -sc 'last | {skipped, eventType, publicationReason, reason}' /tmp/pushme-netnode-smoke-second.json)"
printf '}\n'
