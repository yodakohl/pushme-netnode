# pushme-netnode

## This is the start of an AI agent economy.

Small agent that measures internet connectivity and publishes events to the PushMe event network.

It is intentionally minimal:
- no external npm dependencies
- runs as a single Node process
- probes multiple independent destinations
- measures DNS, HTTP latency, and packet loss per destination
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
- impacted profile count
- per-destination metrics
- average DNS / HTTP / ping latency across successful probes
- maximum packet loss across probes
- whether the issue looks localized, partial, or global
- probe timestamp

By default it probes three different destinations:
- Cloudflare
- Google
- Quad9

That makes the output materially more useful than a single ping target:
- one broken target usually means a localized issue
- multiple impacted targets suggest a broader uplink or ISP problem
- downstream agents can react differently based on that distinction

## Quick start

```bash
npm install
npm run setup
npm start
```

What `npm run setup` does:
- asks for your node name
- registers a publisher org on PushMe
- writes `.env` with your `PUSHME_API_KEY`
- sets a location slug for this machine
- optional contact email can be added, but bots do not need one

Non-interactive setup also works:

```bash
npm run setup -- \
  --org-name "My Netnode" \
  --location fra-home
```

If you want to inspect the probe before publishing:

```bash
npm start -- --once --dry-run
```

## Environment

```bash
PUSHME_API_KEY=...
PUSHME_BOT_URL=https://pushme.site
NETNODE_TARGET_HOST=1.1.1.1
NETNODE_TARGET_URL=https://1.1.1.1/cdn-cgi/trace
NETNODE_DNS_HOST=example.com
NETNODE_PROFILES_JSON=[{"name":"cloudflare","label":"Cloudflare","targetHost":"1.1.1.1","targetUrl":"https://1.1.1.1/cdn-cgi/trace","dnsHost":"one.one.one.one"},{"name":"google","label":"Google","targetHost":"8.8.8.8","targetUrl":"https://www.google.com/generate_204","dnsHost":"google.com"},{"name":"quad9","label":"Quad9","targetHost":"9.9.9.9","targetUrl":"https://www.quad9.net/","dnsHost":"dns.quad9.net"}]
NETNODE_LOCATION=home-office
NETNODE_PACKET_COUNT=4
NETNODE_INTERVAL_MS=60000
NETNODE_STATE_FILE=./netnode-state.json
NETNODE_PUBLISH_MODE=changes
```

Notes:
- `PUSHME_API_KEY` is created and written by `npm run setup`
- `NETNODE_PROFILES_JSON` is the main value-setting knob: each profile adds an independent destination
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
npm run setup
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
  "summary": "2/3 targets impacted: Cloudflare degraded, Quad9 down, avg DNS 184 ms, avg HTTP 611 ms, max loss 100%.",
  "body": "Human-readable explanation of the measurement.",
  "sourceUrl": "https://status.example.net",
  "externalId": "home-office-2026-03-07T13:00:00.000Z",
  "tags": ["network", "latency", "packet-loss"],
  "metadata": {
    "location": "home-office",
    "severity": "degraded",
    "scope": "partial",
    "profileCount": 3,
    "impactedProfileCount": 2,
    "impactedProfilesCsv": "cloudflare,quad9",
    "avgDnsLatencyMs": 184,
    "avgHttpLatencyMs": 611,
    "maxPacketLossPct": 100,
    "profile_cloudflare_severity": "degraded",
    "profile_cloudflare_targetHost": "1.1.1.1",
    "profile_cloudflare_dnsLatencyMs": 420,
    "profile_cloudflare_httpLatencyMs": 503,
    "profile_cloudflare_packetLossPct": 0,
    "profilesJson": "[{"name":"cloudflare","severity":"degraded"}]"
  }
}
```

## Suggested usage

- router health
- branch office uplink monitoring
- factory internet path monitoring
- edge node health reporting
- ISP outage detection
- cross-target path validation for autonomous operations agents
- better evidence for whether an alert is local noise or broader internet degradation

## Limitations

- Packet loss uses the system `ping` command and currently assumes a Unix-like environment.
- HTTP latency is measured with a simple fetch, not a browser-grade synthetic check.
- This sample is designed to be easy to integrate, not to replace dedicated network observability products.
