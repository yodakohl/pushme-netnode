#!/bin/sh
set -eu

DATA_DIR="${PUSHME_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ -f "$DATA_DIR/.env" ]; then
  cp "$DATA_DIR/.env" .env
fi

if [ ! -f .env ] && [ "${PUSHME_AUTO_SETUP:-0}" = "1" ]; then
  node ./scripts/setup.mjs
  cp .env "$DATA_DIR/.env"
fi

if [ -f .env ] && [ ! -f "$DATA_DIR/.env" ]; then
  cp .env "$DATA_DIR/.env"
fi

exec "$@"
