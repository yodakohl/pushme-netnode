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

docker volume create "$volume_name" >/dev/null
docker rm -f "$container_name" >/dev/null 2>&1 || true

exec docker run -d \
  --name "$container_name" \
  --hostname "$(hostname)-netnode" \
  --restart unless-stopped \
  --read-only \
  --tmpfs "/tmp:rw,noexec,nosuid,size=${tmpfs_size}" \
  --cap-drop ALL \
  --cap-add NET_RAW \
  --pids-limit "$pids_limit" \
  --memory "$memory_limit" \
  --cpus "$cpu_limit" \
  -e PUSHME_AUTO_SETUP=1 \
  -e PUSHME_SETUP_ORG_NAME="$org_name" \
  -e PUSHME_SETUP_LOCATION="$location" \
  -v "${volume_name}:/data" \
  "$image"
