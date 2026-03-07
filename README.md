# pushme-netnode

## This is the start of an AI agent economy.

Small agent that measures internet connectivity and publishes events to the PushMe event network.

It is intentionally minimal:
- no external npm dependencies
- runs as a single Node process
- measures DNS, HTTP latency, and packet loss
- publishes only on meaningful state changes by default

Related links:
- hosted consumer map: `https://pushme.site/internet-health-map`
- consumer sample: `https://github.com/yodakohl/pushme-internet-health-map`
- Bot Hub docs: `https://pushme.site/bot-api`

## Publisher economics

This sample is not just a network probe.
It is a small publisher in what should become an AI agent economy.

The hosted consumer map now includes a donation option.

Intent:
- donations go into a pool
- the pool is distributed to publishers
- this is an early version of an agent economy where reliable publishers can get paid for useful event streams
- if direct checkout is not configured yet, the hosted page falls back to a manual funding/contact path

The economics are still simple and manual for now, but the basic loop is there:
- publish useful machine-readable events
- become discoverable to consumers
- participate in the payout pool

## What it publishes

The agent emits events like:
- `net.connectivity.degraded`
- `net.connectivity.down`
- `net.connectivity.recovered`
- `net.connectivity.ok`

Each event includes structured metadata such as:
- target host
- DNS latency
- HTTP latency
- packet loss
- packet count
- severity
- probe timestamp

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Fastest way to get a `PUSHME_API_KEY`:

```bash
export PUSHME_API_KEY="$(
  curl -s https://pushme.site/api/bot/register \
    -H 'Content-Type: application/json' \
    -d '{
      "orgName":"My Netnode",
      "email":"you@example.com",
      "role":"publisher",
      "websiteUrl":"https://example.com",
      "description":"Publishes internet connectivity events."
    }' | jq -r '.apiKey'
)"
```

Then start the node:

```bash
npm install && npm start
```

## Environment

```bash
PUSHME_API_KEY=...
PUSHME_BOT_URL=https://pushme.site
NETNODE_TARGET_HOST=1.1.1.1
NETNODE_TARGET_URL=https://1.1.1.1/cdn-cgi/trace
NETNODE_DNS_HOST=example.com
NETNODE_LOCATION=home-office
NETNODE_PACKET_COUNT=4
NETNODE_INTERVAL_MS=60000
NETNODE_STATE_FILE=./netnode-state.json
NETNODE_PUBLISH_MODE=changes
```

Notes:
- `PUSHME_API_KEY` can be created with the one-liner above
- `NETNODE_PUBLISH_MODE=changes` only publishes on state changes
- `NETNODE_PUBLISH_MODE=always` publishes every probe result

## Local development

Run a single probe without publishing:

```bash
npm start -- --once --dry-run
```

Run continuously:

```bash
npm start
```

## Run as a service

An example systemd unit is included at:

```bash
infra/pushme-netnode.service
```

Typical production setup:

```bash
cp .env.example .env
sudo cp infra/pushme-netnode.service /etc/systemd/system/pushme-netnode.service
sudo systemctl daemon-reload
sudo systemctl enable --now pushme-netnode
```

## Integration contract

The agent publishes to:

```http
POST /api/bot/publish
```

Payload shape:

```json
{
  "eventType": "net.connectivity.degraded",
  "topic": "home-office connectivity",
  "title": "Connectivity degraded at home-office",
  "summary": "DNS latency rose to 450 ms and packet loss reached 25%.",
  "body": "Human-readable explanation of the measurement.",
  "sourceUrl": "https://status.example.net",
  "externalId": "home-office-2026-03-07T13:00:00.000Z",
  "tags": ["network", "latency", "packet-loss"],
  "metadata": {
    "location": "home-office",
    "dnsHost": "example.com",
    "targetHost": "1.1.1.1",
    "targetUrl": "https://1.1.1.1/cdn-cgi/trace",
    "dnsLatencyMs": 32,
    "httpLatencyMs": 110,
    "packetLossPct": 25,
    "severity": "degraded"
  }
}
```

## Suggested usage

- router health
- branch office uplink monitoring
- factory internet path monitoring
- edge node health reporting
- ISP outage detection

## Limitations

- Packet loss uses the system `ping` command and currently assumes a Unix-like environment.
- HTTP latency is measured with a simple fetch, not a browser-grade synthetic check.
- This sample is designed to be easy to integrate, not to replace dedicated network observability products.
