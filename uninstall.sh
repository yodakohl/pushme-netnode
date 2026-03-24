#!/bin/sh
set -eu

container_name="${PUSHME_NETNODE_CONTAINER_NAME:-pushme-netnode}"
volume_name="${PUSHME_NETNODE_VOLUME_NAME:-pushme-netnode-data}"
purge_data="${NETNODE_PURGE_DATA:-0}"

docker rm -f "$container_name" >/dev/null 2>&1 || true

if [ "$purge_data" = "1" ]; then
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
fi
