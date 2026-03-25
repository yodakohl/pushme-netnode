# pushme-netnode

`pushme-netnode` is the main low-footprint netnode runtime for PushMe.

It keeps the same default probe set and one-minute cadence as the older
Node-based implementation, but replaces the resident JavaScript runtime with a
small shell-based loop plus short-lived probe tools.

## Quick start

Install the published container:

```sh
./install.sh
```

Remove it:

```sh
./uninstall.sh
```

Remove it and delete persisted state:

```sh
NETNODE_PURGE_DATA=1 ./uninstall.sh
```

Local dry run:

```sh
NETNODE_LOCATION=test-node NETNODE_PUBLISH_MODE=changes sh ./netnode.sh --once --dry-run
```

## Operator contract

- default profiles: 9
- default cadence: 60 seconds
- default ICMP packets per packet-enabled target: 4
- published event types:
  - `net.connectivity.degraded`
  - `net.connectivity.down`
  - `net.connectivity.recovered`
  - `net.provider.degraded`
  - `net.provider.down`
  - `net.provider.recovered`
- startup endpoint: `POST /api/bot/netnode/startup`
- heartbeat endpoint: `POST /api/bot/netnode/heartbeat`
- publish endpoint: `POST /api/bot/publish`
- status endpoint: `GET /api/bot/netnode/status`
- state path: `/data/netnode-state.tsv`
- env path: `/data/netnode.env`

## Runtime model

- runtime is `sh` + `curl` + `getent/nslookup` + `ping`
- normal web targets prefer `HEAD`; provider-status endpoints fetch bodies
- server-facing liveness uses a heartbeat every probe loop; payouts and live map
  status do not depend only on incident publishes
- provider-reported incidents are emitted separately from direct connectivity
  incidents so official status pages do not masquerade as broken internet paths
- the full event payload is only assembled when a publish is required
- env/state files are strict tab-separated key/value files, not sourced as shell
  code
- startup and publish traffic must use `https://` unless explicitly pointed at a
  localhost-style development URL

## Recommended container flags

Use these limits in production:

- `--read-only`
- `--tmpfs /tmp:rw,noexec,nosuid,size=8m`
- `--cap-drop ALL`
- `--cap-add NET_RAW`
- `--pids-limit 32`
- `--memory 16m`
- `--cpus 0.10`

`no-new-privileges` is intentionally not part of the default contract yet,
because it failed on the tested Docker/runtime stack while launching even
`/bin/sh`.

## Verification

Generate a machine-readable verification report:

```sh
./verify.sh
```

That report includes:

- pinned base image digest
- source file hashes
- image file hashes
- whether source and built image match
- installed packages from the Dockerfile
- default probe set
- required runtime restrictions

## Test harness

Production-connected smoke test:

```sh
PUSHME_REPO_ROOT=/home/PushMe ./smoke-test.sh
```

Longer soak test under the hardened container profile:

```sh
PUSHME_REPO_ROOT=/home/PushMe SOAK_DURATION_SECONDS=600 ./soak-test.sh
```

Both tests expect Docker, `curl`, `jq`, and a way to resolve `DATABASE_URL`
through either:

- `DATABASE_URL` already being set, or
- `PUSHME_REPO_ROOT/backend/.env` existing

## Supported configuration

- `PUSHME_API_KEY`
- `PUSHME_BOT_URL`
- `PUSHME_AUTO_SETUP=1`
- `PUSHME_SETUP_ORG_NAME`
- `PUSHME_SETUP_LOCATION`
- `PUSHME_SETUP_DESCRIPTION`
- `PUSHME_SETUP_WEBSITE_URL`
- `NETNODE_LOCATION`
- `NETNODE_PACKET_COUNT`
- `NETNODE_INTERVAL_MS`
- `NETNODE_PUBLISH_MODE`
- `NETNODE_RELEASE_CHANNEL`
- `NETNODE_IMAGE_REPOSITORY`
- `NETNODE_IMAGE`
- `NETNODE_VERSION`
- `NETNODE_STATE_FILE`
- `NETNODE_ENV_FILE`
- `NETNODE_SOURCE_URL`
- `NETNODE_COUNTRY_CODE`
- `NETNODE_COUNTRY`
- `NETNODE_REGION`
- `NETNODE_CITY`
- `NETNODE_PROVIDER`
- `NETNODE_PROVIDER_DOMAIN`
- `NETNODE_ASN`
- `NETNODE_NETWORK_TYPE`

## Current limits

- default profiles are compiled into the script; custom profile JSON is not yet
  supported
- targets small Linux hosts and Linux containers, not bare microcontrollers
- much smaller than the older Node runtime, but not claiming a hard 8 MB peak on
  every environment
