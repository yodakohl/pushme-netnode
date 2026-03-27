#!/bin/sh
set -eu

script_dir="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
pushme_repo_root="${PUSHME_REPO_ROOT:-/home/PushMe}"
tab="$(printf '\t')"
image_tag="${PUSHME_NETNODE_TEST_IMAGE:-pushme-netnode-soaktest}"
host_base_url="${PUSHME_BOT_URL:-}"
container_base_url="${host_base_url:-}"
duration_seconds="${SOAK_DURATION_SECONDS:-600}"
sample_interval_seconds="${SOAK_SAMPLE_INTERVAL_SECONDS:-15}"
work_dir="$(mktemp -d)"
run_id="$(date +%s)-$$"
org_name="pushme-netnode-soak-${run_id}"
location_name="${org_name}"
data_volume="pushme-netnode-soak-${run_id}"
container_name="pushme-netnode-soak-${run_id}"
mock_container_name="pushme-netnode-soak-mock-${run_id}"
network_name="pushme-netnode-soak-net-${run_id}"
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
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [ "${KEEP_SOAKTEST_ARTIFACTS:-0}" = "1" ]; then
    if [ "$using_mock" -eq 1 ]; then
      echo "[pushme-netnode soak-test] keeping artifacts in ${work_dir}, volume ${data_volume}, mock ${mock_container_name}, network ${network_name} for ${org_name}" >&2
    else
      echo "[pushme-netnode soak-test] keeping artifacts in ${work_dir}, volume ${data_volume} for ${org_name}" >&2
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

set -- docker run -d
[ "$using_mock" -eq 1 ] && set -- "$@" --network "$network_name"
[ "$using_mock" -eq 1 ] && set -- "$@" -e NETNODE_ALLOW_HTTP_BASE_URLS="$container_base_url"
set -- "$@" \
  --name "$container_name" \
  --restart no \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=8m \
  --cap-drop ALL \
  --cap-add NET_RAW \
  --pids-limit 32 \
  --memory 16m \
  --cpus 0.10 \
  -e PUSHME_AUTO_SETUP=1 \
  -e PUSHME_BOT_URL="$container_base_url" \
  -e PUSHME_SETUP_ORG_NAME="$org_name" \
  -e PUSHME_SETUP_LOCATION="$location_name" \
  -e NETNODE_COUNTRY=Germany \
  -e NETNODE_PROVIDER=DigitalOcean \
  -e NETNODE_ASN=14061 \
  -e NETNODE_NETWORK_TYPE=cloud \
  -e NETNODE_PUBLISH_MODE=changes \
  -v "${data_volume}:/data" \
  "$image_tag"
"$@" >/dev/null

env_attempt=0
while [ "$env_attempt" -lt 30 ]; do
  if docker run --rm --entrypoint sh -v "${data_volume}:/data" "$image_tag" -lc 'test -s /data/netnode.env' >/dev/null 2>&1; then
    break
  fi
  env_attempt=$((env_attempt + 1))
  sleep 2
done

if [ "$env_attempt" -ge 30 ]; then
  echo "[pushme-netnode soak-test] env file was not created in time" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

docker exec "$container_name" cat /data/netnode.env >"${work_dir}/netnode.env"
[ -s "${work_dir}/netnode.env" ]

pushme_api_key="$(awk -F "$tab" '$1=="PUSHME_API_KEY"{print $2; exit}' "${work_dir}/netnode.env")"
[ -n "${pushme_api_key:-}" ]

status_json=''
status_attempt=0
while [ "$status_attempt" -lt 12 ]; do
  status_json="$(curl -fsS -H "authorization: Bearer ${pushme_api_key}" "${host_base_url}/api/bot/netnode/status")"
  if printf '%s' "$status_json" | jq -e '.runtime.nodeVersion | length > 0' >/dev/null &&
    printf '%s' "$status_json" | jq -e '.runtime.lastSeenAt != null and .runtime.onlineNow == true' >/dev/null &&
    printf '%s' "$status_json" | jq -e '.recentNodeEvents | type == "array"' >/dev/null; then
    break
  fi
  status_attempt=$((status_attempt + 1))
  sleep 5
done

if ! printf '%s' "$status_json" | jq -e '.runtime.nodeVersion | length > 0' >/dev/null ||
  ! printf '%s' "$status_json" | jq -e '.runtime.lastSeenAt != null and .runtime.onlineNow == true' >/dev/null ||
  ! printf '%s' "$status_json" | jq -e '.recentNodeEvents | type == "array"' >/dev/null; then
  echo "[pushme-netnode soak-test] status endpoint never showed a live runtime with heartbeat state" >&2
  printf '%s\n' "$status_json" >&2
  docker logs "$container_name" >&2 || true
  exit 1
fi

printf '' >"${work_dir}/stats.log"
samples=0
start_epoch="$(date +%s)"
end_epoch=$((start_epoch + duration_seconds))
while [ "$(date +%s)" -lt "$end_epoch" ]; do
  if ! docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null | grep -qx true; then
    echo "[pushme-netnode soak-test] container stopped unexpectedly" >&2
    docker logs "$container_name" >&2 || true
    exit 1
  fi
  sample="$(docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}' "$container_name" 2>/dev/null || true)"
  if [ -n "$sample" ]; then
    printf '%s\n' "$sample" >>"${work_dir}/stats.log"
    samples=$((samples + 1))
  fi
  sleep "$sample_interval_seconds"
done

final_status_json="$(curl -fsS -H "authorization: Bearer ${pushme_api_key}" "${host_base_url}/api/bot/netnode/status")"
docker logs "$container_name" >"${work_dir}/container.log" 2>&1 || true
docker exec "$container_name" cat /data/netnode-state.tsv >"${work_dir}/netnode-state.tsv"
[ -s "${work_dir}/netnode-state.tsv" ]

stats_summary="$(
  awk -F'|' '
    function trim(s) {
      gsub(/^[ \t]+|[ \t]+$/, "", s);
      return s;
    }
    function mem_to_bytes(value,   n, unit) {
      value = trim(value);
      sub(/ \/.*$/, "", value);
      n = value;
      unit = "";
      if (match(value, /[A-Za-z]+$/)) {
        unit = substr(value, RSTART);
        n = substr(value, 1, RSTART - 1);
      }
      n += 0;
      if (unit == "KiB") return int(n * 1024);
      if (unit == "MiB") return int(n * 1024 * 1024);
      if (unit == "GiB") return int(n * 1024 * 1024 * 1024);
      if (unit == "B" || unit == "") return int(n);
      return int(n);
    }
    function cpu_to_milli(value) {
      value = trim(value);
      sub(/%$/, "", value);
      return int((value + 0) * 1000);
    }
    {
      mem_bytes = mem_to_bytes($1);
      cpu_milli = cpu_to_milli($2);
      if (mem_bytes > max_mem_bytes) {
        max_mem_bytes = mem_bytes;
        max_mem_human = trim($1);
      }
      if (cpu_milli > max_cpu_milli) {
        max_cpu_milli = cpu_milli;
        max_cpu_human = trim($2);
      }
      count += 1;
    }
    END {
      printf "%s|%s|%s|%s|%s", max_mem_bytes + 0, max_mem_human, (max_cpu_milli + 0) / 1000, max_cpu_human, count + 0;
    }
  ' "${work_dir}/stats.log"
)"

IFS='|' read -r max_mem_bytes max_mem_human max_cpu_percent max_cpu_human sample_count <<EOF
$stats_summary
EOF

printf '{\n'
printf '  "image": "%s",\n' "$image_tag"
printf '  "orgName": "%s",\n' "$org_name"
printf '  "durationSeconds": %s,\n' "$duration_seconds"
printf '  "sampleIntervalSeconds": %s,\n' "$sample_interval_seconds"
printf '  "samples": %s,\n' "${sample_count:-0}"
printf '  "runtimeNodeVersion": %s,\n' "$(printf '%s' "$final_status_json" | jq -c '.runtime.nodeVersion')"
printf '  "runtimeImage": %s,\n' "$(printf '%s' "$final_status_json" | jq -c '.runtime.image')"
printf '  "recentEventCount": %s,\n' "$(printf '%s' "$final_status_json" | jq -r '.recentNodeEvents | length')"
printf '  "maxMemBytes": %s,\n' "${max_mem_bytes:-0}"
printf '  "maxMemUsage": %s,\n' "$(jq -Rn --arg v "${max_mem_human:-}" '$v')"
printf '  "maxCpuPercent": %s,\n' "$(jq -Rn --arg v "${max_cpu_percent:-0}" '$v | tonumber')"
printf '  "maxCpuSample": %s,\n' "$(jq -Rn --arg v "${max_cpu_human:-}" '$v')"
printf '  "finalRunningState": %s,\n' "$(docker inspect --format '{{json .State.Running}}' "$container_name")"
printf '  "stateFile": %s\n' "$(jq -Rs . < "${work_dir}/netnode-state.tsv")"
printf '}\n'
