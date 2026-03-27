#!/bin/sh
set -eu

image="${PUSHME_NETNODE_IMAGE:-ghcr.io/yodakohl/pushme-netnode:stable}"
container_name="${PUSHME_NETNODE_CONTAINER_NAME:-pushme-netnode}"
volume_name="${PUSHME_NETNODE_VOLUME_NAME:-pushme-netnode-data}"
org_name="${PUSHME_SETUP_ORG_NAME:-$(hostname)-netnode}"
location="${PUSHME_SETUP_LOCATION:-$(hostname)-netnode}"
cpu_limit="${PUSHME_NETNODE_CPU_LIMIT:-0.10}"
memory_limit="${PUSHME_NETNODE_MEMORY_LIMIT:-16m}"
pids_limit="${PUSHME_NETNODE_PIDS_LIMIT:-32}"
tmpfs_size="${PUSHME_NETNODE_TMPFS_SIZE:-8m}"
auto_setup="${PUSHME_AUTO_SETUP:-1}"

image_tag() {
  case "$1" in
    *@*) printf '' ;;
    *:*) printf '%s' "${1##*:}" ;;
    *) printf 'stable' ;;
  esac
}

default_release_channel() {
  tag="$(image_tag "$1")"
  case "$tag" in
    edge) printf 'edge' ;;
    stable|'') printf 'stable' ;;
    *) printf 'stable' ;;
  esac
}

pull_image() {
  if docker pull "$image" >/dev/null; then
    return 0
  fi
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "[pushme-netnode] warning: failed to pull ${image}; using local cached image" >&2
    return 0
  fi
  echo "[pushme-netnode] failed to pull ${image} and no local image is available" >&2
  return 1
}

release_channel="${NETNODE_RELEASE_CHANNEL:-$(default_release_channel "$image")}"
temp_container="${container_name}-next-$$"
backup_container="${container_name}-prev-$$"
had_existing=0

cleanup() {
  docker rm -f "$temp_container" >/dev/null 2>&1 || true
}

restore_backup() {
  [ "$had_existing" -eq 1 ] || return 0
  if docker container inspect "$backup_container" >/dev/null 2>&1; then
    docker rm -f "$container_name" >/dev/null 2>&1 || true
    docker rename "$backup_container" "$container_name" >/dev/null 2>&1 || true
    docker start "$container_name" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

docker volume create "$volume_name" >/dev/null
pull_image
docker rm -f "$temp_container" >/dev/null 2>&1 || true

set -- docker create \
  --name "$temp_container" \
  --hostname "$(hostname)-netnode" \
  --restart unless-stopped \
  --read-only \
  --tmpfs "/tmp:rw,noexec,nosuid,size=${tmpfs_size}" \
  --cap-drop ALL \
  --cap-add NET_RAW \
  --pids-limit "$pids_limit" \
  --memory "$memory_limit" \
  --cpus "$cpu_limit" \
  -e PUSHME_AUTO_SETUP="$auto_setup" \
  -e PUSHME_SETUP_ORG_NAME="$org_name" \
  -e PUSHME_SETUP_LOCATION="$location" \
  -e NETNODE_IMAGE="$image" \
  -e NETNODE_RELEASE_CHANNEL="$release_channel" \
  -v "${volume_name}:/data"

[ -n "${PUSHME_API_KEY:-}" ] && set -- "$@" -e PUSHME_API_KEY="$PUSHME_API_KEY"
[ -n "${PUSHME_BOT_URL:-}" ] && set -- "$@" -e PUSHME_BOT_URL="$PUSHME_BOT_URL"

set -- "$@" "$image"
"$@" >/dev/null

if docker container inspect "$container_name" >/dev/null 2>&1; then
  had_existing=1
  docker rm -f "$backup_container" >/dev/null 2>&1 || true
  docker rename "$container_name" "$backup_container" >/dev/null
  docker stop "$backup_container" >/dev/null 2>&1 || true
fi

if ! docker rename "$temp_container" "$container_name" >/dev/null; then
  restore_backup
  echo "[pushme-netnode] failed to activate replacement container" >&2
  exit 1
fi

trap - EXIT INT TERM

if ! started_container="$(docker start "$container_name")"; then
  restore_backup
  echo "[pushme-netnode] failed to start ${image}" >&2
  exit 1
fi

docker rm -f "$backup_container" >/dev/null 2>&1 || true
printf '%s\n' "$started_container"
