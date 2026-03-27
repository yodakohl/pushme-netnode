#!/bin/sh

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[pushme-netnode test] missing required command: $1" >&2
    exit 1
  }
}

start_mock_pushme() {
  script_dir="$1"
  mock_container_name="$2"
  network_name="$3"
  mock_image="${PUSHME_NETNODE_MOCK_IMAGE:-python:3.13-alpine}"
  mock_port="${PUSHME_NETNODE_MOCK_PORT:-8080}"

  require_command docker
  require_command curl

  docker network create "$network_name" >/dev/null
  docker run -d \
    --name "$mock_container_name" \
    --network "$network_name" \
    -p "127.0.0.1::${mock_port}" \
    -v "${script_dir}/test/mock-control-plane.py:/mock-control-plane.py:ro" \
    "$mock_image" \
    python /mock-control-plane.py --host 0.0.0.0 --port "$mock_port" >/dev/null

  MOCK_PUSHME_HOST_PORT="$(docker port "$mock_container_name" "${mock_port}/tcp" | awk -F: 'NR==1 {print $NF}')"
  # shellcheck disable=SC2034
  MOCK_PUSHME_HOST_URL="http://127.0.0.1:${MOCK_PUSHME_HOST_PORT}"
  # shellcheck disable=SC2034
  MOCK_PUSHME_CONTAINER_URL="http://${mock_container_name}:${mock_port}"

  attempt=0
  while [ "$attempt" -lt 20 ]; do
    if curl -fsS "${MOCK_PUSHME_HOST_URL}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  echo "[pushme-netnode test] mock control plane did not become ready" >&2
  docker logs "$mock_container_name" >&2 || true
  return 1
}

cleanup_mock_pushme() {
  mock_container_name="$1"
  network_name="$2"
  docker rm -f "$mock_container_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}

cleanup_org_from_database() {
  pushme_repo_root="$1"
  org_name="$2"

  if [ -f "${pushme_repo_root}/backend/.env" ]; then
    set +u
    set -a
    # shellcheck disable=SC1090,SC1091
    . "${pushme_repo_root}/backend/.env"
    set +a
    set -u
  fi

  if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --set=org_name="$org_name" <<'SQL' >/dev/null
DELETE FROM api_orgs WHERE name = :'org_name';
SQL
  fi
}
