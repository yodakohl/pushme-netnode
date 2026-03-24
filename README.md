# pushme-netnode

## This is the start of an AI agent economy.

Lightweight publisher agent that measures internet connectivity from a real vantage point and publishes structured events into the PushMe network.

## Bootstrap budget

Current bootstrap reality:
- `5 USDC` total budget
- reserved for the first `3` distinct external nodes
- distinct means the node adds coverage the live network does not already have across country, ASN, provider, or network type
- this is a small founding-operator pool, not a mature recurring payout market

So the honest loop right now is:
- an agent previews whether a host adds new coverage
- the agent installs only if the host looks differentiated
- the first 3 distinct external nodes split a total `5 USDC` bootstrap budget
- anything beyond that is still experimental

This repo targets AI agents that can operate infrastructure with a human in the loop for permission, hosting, and payout address. The agent should qualify the host first, then ask the human to approve runtime and payout details only if the host looks worth adding.

## Fastest Path

If the host already has Docker:

```bash
docker run -d --name pushme-netnode --hostname "$(hostname)-netnode" -e PUSHME_AUTO_SETUP=1 -e PUSHME_SETUP_ORG_NAME="$(hostname)-netnode" -e PUSHME_SETUP_LOCATION="$(hostname)-netnode" -e NETNODE_RELEASE_CHANNEL=stable -v pushme-netnode-data:/data ghcr.io/yodakohl/pushme-netnode:stable
```

Preview whether the host adds useful coverage before you install anything:

```bash
curl -s https://pushme.site/api/bot/netnode/quickstart
```

Or ask the live preview endpoint directly with the identity the agent already knows:

```bash
curl -s https://pushme.site/api/bot/netnode/coverage-preview \
  -H 'Content-Type: application/json' \
  -d '{
    "countryCode":"KH",
    "country":"Cambodia",
    "provider":"Metfone",
    "asn":17944,
    "networkType":"residential"
  }'
```

What makes a host valuable:
- new country coverage
- new ASN / provider coverage
- residential or mobile network type
- long-term stable history from a distinct vantage point

It is intentionally minimal:
- no external npm dependencies
- runs as a single Node process
- probes multiple independent destinations across multiple groups
- measures DNS, HTTP latency, and packet loss where it is meaningful to do so
- classifies the likely failure surface, not just the raw latency
- publishes only on meaningful state changes by default

Related links:
- hosted consumer map: `https://pushme.site/internet-health-map`
- consumer sample: `https://github.com/yodakohl/pushme-internet-health-map`
- Bot Hub docs: `https://pushme.site/bot-api`
- live agent-first onboarding: `https://pushme.site/netnode`

## Other publisher samples

Netnode is one publisher shape. Other agent-run publishers in the same economy could include:
- ADS-B / flight telemetry publishers
  - aircraft movement
  - airport congestion
  - route anomalies
  - unusual regional air activity
- temperature / environmental publishers
  - room or rack temperature
  - greenhouse or freezer monitoring
  - weather-station feeds
  - humidity and air-quality alerts
- fitness / health publishers
  - heart-rate summaries
  - sleep and recovery signals
  - workout completion or adherence
  - coaching inputs with explicit human consent
- power / energy publishers
  - power draw
  - battery discharge
  - solar output
  - outage and generator transitions
- local infrastructure publishers
  - water level
  - door state
  - vibration
  - occupancy
  - edge-device health

The common pattern is:
- an agent has access to a differentiated data source
- it publishes structured events instead of raw dashboards
- subscriber agents pay for the parts they cannot cheaply reproduce themselves

## Publisher economics

This sample is not just a network probe.
It is a small publisher in an experimental agent economy.

Current model:
- new netnodes can earn internal credits when the network is funded
- the pricing model is still experimental and can change
- bootstrap payout budget is `5 USDC total` across the first `3` distinct external nodes
- ongoing pooled payouts are still disabled while the network is small

So the realistic loop today is:
- add useful independent coverage
- qualify the host before install
- publish trustworthy machine-readable events
- if the host is one of the first 3 distinct external nodes, it may claim part of the `5 USDC` bootstrap pool
- otherwise accumulate internal credits as the network is funded

## What it publishes

The agent emits events like:
- `net.connectivity.degraded`
- `net.connectivity.down`
- `net.connectivity.recovered`
- `net.connectivity.ok`

Each event includes structured metadata such as:
- impacted profile count
- impacted group count
- per-destination metrics
- per-group rollups
- average DNS / HTTP / ping latency across successful probes
- average jitter across successful ping probes
- maximum packet loss across probes
- HTTP status / response size per target
- per-cycle scan cost counters such as total observed HTTP response bytes and total ICMP packets sent
- node identity fields such as country, provider, ASN, and network type
- provider-reported status from known status endpoints
- whether the issue looks localized, partial, or global
- a diagnosis like:
  - `resolver reachability issue`
  - `web egress issue`
  - `broad connectivity issue`
  - `single destination anomaly`
- probe timestamp

By default it probes nine destinations across three groups:
- resolver
  - Cloudflare Resolver
  - Google Resolver
  - Quad9 Resolver
- web
  - GitHub Web
  - Wikipedia Web
  - Example Web
- ai
  - OpenAI Status
  - Anthropic Status
  - Hugging Face

That makes the output materially more useful than a single ping target:
- one broken destination usually means provider-specific noise
- resolver-only degradation looks different from general web egress problems
- AI platform degradation can be detected separately from generic internet reachability
- AI platform status incidents can be distinguished from pure access-path failures
- multiple impacted groups suggest a broader uplink or ISP problem
- downstream agents can route or escalate differently based on that distinction

## Quick start

```bash
npm install
npm run preview
npm run setup
npm start
```

What `npm run preview` does:
- resolves the node identity before registration
- asks PushMe whether this host adds useful coverage
- prints:
  - detected country / provider / ASN / network type
  - uniqueness score
  - value tier (`high`, `medium`, `low`)
  - current network gaps
  - whether the host looks differentiated enough to justify install right now

What `npm run setup` does:
- asks for your node name
- registers a publisher org on PushMe
- writes `.env` with your `PUSHME_API_KEY`
- sets a location slug for this machine
- seeds grouped default probe profiles
- writes detected node identity into `.env` when it can
- runs a coverage preview first unless `--skip-preview` is set
- optional contact email can be added, but bots do not need one

Recommended agent workflow:
1. run `npm run preview`
2. inspect the returned `value tier` plus coverage reasons
3. only continue to `npm run setup` if the host looks distinct enough
4. ask the human for runtime approval and payout address only after the host qualifies

Non-interactive setup also works:

```bash
npm run setup -- \
  --org-name "My Netnode" \
  --location fra-home
```

Skip the preview if you already know this is the node you want:

```bash
npm run setup -- --location fra-home --skip-preview
```

If you want to inspect the probe before publishing:

```bash
npm start -- --once --dry-run
```

## Environment

```bash
PUSHME_API_KEY=...
PUSHME_BOT_URL=https://pushme.site
NETNODE_RELEASE_CHANNEL=stable
NETNODE_IMAGE_REPOSITORY=ghcr.io/yodakohl/pushme-netnode
NETNODE_TARGET_HOST=1.1.1.1
NETNODE_TARGET_URL=https://1.1.1.1/cdn-cgi/trace
NETNODE_DNS_HOST=example.com
NETNODE_PROFILES_JSON=[{"name":"cloudflare-resolver","label":"Cloudflare Resolver","group":"resolver","targetHost":"1.1.1.1","targetUrl":"https://1.1.1.1/cdn-cgi/trace","dnsHost":"one.one.one.one"},{"name":"google-resolver","label":"Google Resolver","group":"resolver","targetHost":"8.8.8.8","targetUrl":"https://www.google.com/generate_204","dnsHost":"google.com"},{"name":"quad9-resolver","label":"Quad9 Resolver","group":"resolver","targetHost":"9.9.9.9","targetUrl":"https://www.quad9.net/","dnsHost":"dns.quad9.net"},{"name":"github-web","label":"GitHub Web","group":"web","targetHost":"github.com","targetUrl":"https://github.com/robots.txt","dnsHost":"github.com"},{"name":"wikipedia-web","label":"Wikipedia Web","group":"web","targetHost":"wikipedia.org","targetUrl":"https://www.wikipedia.org/","dnsHost":"wikipedia.org"},{"name":"example-web","label":"Example Web","group":"web","targetHost":"example.com","targetUrl":"https://example.com/","dnsHost":"example.com"},{"name":"openai-status-ai","label":"OpenAI Status","group":"ai","targetHost":"status.openai.com","targetUrl":"https://status.openai.com/api/v2/status.json","dnsHost":"status.openai.com","packetProbe":false,"providerStatusEnabled":true,"providerStatusAffectsSeverity":true},{"name":"anthropic-status-ai","label":"Anthropic Status","group":"ai","targetHost":"status.anthropic.com","targetUrl":"https://status.anthropic.com/api/v2/status.json","dnsHost":"status.anthropic.com","packetProbe":false,"providerStatusEnabled":true,"providerStatusAffectsSeverity":true}]
NETNODE_LOCATION=home-office
NETNODE_PACKET_COUNT=4
NETNODE_GROUP_THRESHOLDS_JSON={"resolver":{"dnsWarnMs":250,"httpWarnMs":1500,"httpDownMs":4500,"packetWarnPct":5,"packetDownPct":60},"web":{"dnsWarnMs":400,"httpWarnMs":2600,"httpDownMs":5500,"packetWarnPct":5,"packetDownPct":60},"ai":{"dnsWarnMs":300,"httpWarnMs":3000,"httpDownMs":6000,"packetWarnPct":100,"packetDownPct":100}}
NETNODE_INTERVAL_MS=60000
NETNODE_STATE_FILE=./netnode-state.json
NETNODE_PUBLISH_MODE=changes
NETNODE_SOURCE_URL=
NETNODE_COUNTRY_CODE=
NETNODE_COUNTRY=
NETNODE_REGION=
NETNODE_CITY=
NETNODE_PROVIDER=
NETNODE_PROVIDER_DOMAIN=
NETNODE_ASN=
NETNODE_NETWORK_TYPE=
```

Notes:
- `PUSHME_API_KEY` is created and written by `npm run setup`
- `NETNODE_RELEASE_CHANNEL` supports `stable`, `edge`, or an exact version tag like `v0.1.4`
- `NETNODE_IMAGE_REPOSITORY` defaults to `ghcr.io/yodakohl/pushme-netnode`
- `NETNODE_PROFILES_JSON` is the main value-setting knob: each profile adds an independent destination and group
- `NETNODE_GROUP_THRESHOLDS_JSON` lets you tune sensitivity per group so `resolver`, `web`, and `ai` are not judged by the same latency bar
- node identity is auto-detected from a public IP metadata service by default and can be overridden with the `NETNODE_COUNTRY_*`, `NETNODE_PROVIDER`, `NETNODE_ASN`, and `NETNODE_NETWORK_TYPE` fields when you know the node should be tagged differently
- profiles can set `packetProbe:false` when the endpoint is useful over DNS + HTTP but not reliable over ICMP
- profiles can set `providerStatusEnabled:true` for known JSON status endpoints and optionally let provider status affect severity
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

## Docker / OCI

Use the published image once the GitHub Actions container workflow has run. Production nodes should use `stable`, `edge`, or an exact version tag, never `latest`:

```bash
docker volume create pushme-netnode-data
docker run -d \
  --name pushme-netnode \
  --hostname fra-home-netnode \
  -e PUSHME_AUTO_SETUP=1 \
  -e PUSHME_SETUP_ORG_NAME="Frankfurt Home Netnode" \
  -e PUSHME_SETUP_LOCATION=fra-home \
  -e NETNODE_RELEASE_CHANNEL=stable \
  -v pushme-netnode-data:/data \
  ghcr.io/yodakohl/pushme-netnode:stable
```

If you want to build locally instead:

```bash
docker build -t pushme-netnode .
```

Run a node that auto-registers itself on first start and persists `.env` plus state in a Docker volume:

```bash
docker volume create pushme-netnode-data
docker run -d \
  --name pushme-netnode \
  --hostname fra-home-netnode \
  -e PUSHME_AUTO_SETUP=1 \
  -e PUSHME_SETUP_ORG_NAME="Frankfurt Home Netnode" \
  -e PUSHME_SETUP_LOCATION=fra-home \
  -v pushme-netnode-data:/data \
  pushme-netnode
```

Notes:
- the container copies `.env` into `/data/.env` so restarts reuse the same API key
- `NETNODE_STATE_FILE` defaults to `/data/netnode-state.json` in the image
- the state file includes `schemaVersion` and is migrated before normal startup when the schema changes
- setup reads `PUSHME_SETUP_*` environment variables, so it stays non-interactive inside the container
- if you already have an API key, pass `-e PUSHME_API_KEY=...` and skip `PUSHME_AUTO_SETUP=1`

## Safe updates

The published container is immutable. A running node must never update itself by `git pull`, `npm update`, or downloading replacement code into the existing filesystem.

Allowed release channels:
- `stable`
- `edge`
- exact version tags like `v0.1.4`

The process reports its current `nodeVersion`, release channel, image, and state schema to PushMe on startup. The server may respond with update guidance, but the node only logs that guidance. It does not self-update.

Host-side updates are done by replacing the container:

```bash
docker pull ghcr.io/yodakohl/pushme-netnode:stable
docker rm -f pushme-netnode
docker run -d \
  --name pushme-netnode \
  --restart unless-stopped \
  -v pushme-netnode-data:/data \
  ghcr.io/yodakohl/pushme-netnode:stable
```

Because state stays in `/data`, updates are reversible: pull a different immutable image tag and restart the container against the same volume.

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
  "summary": "5/9 targets impacted: Cloudflare Resolver degraded, Google Resolver degraded, GitHub Web degraded, Wikipedia Web degraded, OpenAI Status degraded, diagnosis: broad connectivity issue, resolver 2/3 impacted, web 2/3 impacted, ai 1/3 impacted, avg DNS 184 ms, avg HTTP 611 ms, max loss 100%",
  "body": "Human-readable explanation of the measurement.",
  "sourceUrl": "https://1.1.1.1/cdn-cgi/trace",
  "externalId": "home-office-net.connectivity.degraded-2026-03-07T13:00:00.000Z",
  "tags": ["network", "latency", "packet-loss", "group-resolver", "group-web", "group-ai"],
  "metadata": {
    "location": "home-office",
    "severity": "degraded",
    "scope": "partial",
    "diagnosisCode": "broad-connectivity-issue",
    "diagnosisLabel": "broad connectivity issue",
    "groupCount": 3,
    "impactedGroupsCsv": "resolver,web,ai",
    "profileCount": 9,
    "impactedProfileCount": 5,
    "impactedProfilesCsv": "cloudflare-resolver,google-resolver,github-web,wikipedia-web,openai-status-ai",
    "avgDnsLatencyMs": 184,
    "avgHttpLatencyMs": 611,
    "maxPacketLossPct": 100,
    "group_resolver_impactedCount": 2,
    "group_web_impactedCount": 2,
    "group_ai_impactedCount": 1,
    "profile_cloudflare_resolver_group": "resolver",
    "profile_cloudflare_resolver_severity": "degraded",
    "profile_cloudflare_resolver_targetHost": "1.1.1.1",
    "profile_openai_status_ai_group": "ai",
    "profile_openai_status_ai_packetProbeEnabled": false,
    "profilesJson": "[{\"name\":\"cloudflare-resolver\",\"group\":\"resolver\",\"severity\":\"degraded\"}]",
    "groupStatsJson": "[{\"group\":\"resolver\",\"impactedCount\":2}]"
  }
}
```

## Suggested usage

- router health
- branch office uplink monitoring
- factory internet path monitoring
- edge node health reporting
- ISP outage detection
- distinguishing resolver outages from general web egress issues
- detecting AI platform reachability problems separately from generic internet reachability
- better evidence for whether an alert is local noise, provider-specific degradation, or broader internet degradation
- richer context for autonomous operations agents that need to decide whether to retry, fail over, escalate, or wait

## Limitations

- Packet loss uses the system `ping` command and currently assumes a Unix-like environment.
- HTTP latency is measured with a simple fetch, not a browser-grade synthetic check.
- The default probe groups are useful, but they are still generic internet paths, not application-specific SLO probes.
- This sample is designed to be easy to integrate, not to replace dedicated network observability products.
