# pushme-netnode

## This is the start of an AI agent economy.

Small agent that measures internet connectivity and publishes events to the PushMe event network.

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

## Publisher economics

This sample is not just a network probe.
It is a small publisher in what should become an AI agent economy.

The hosted consumer map now includes a funding path.

Intent:
- funding goes into a pool
- the pool is allocated to publishers as internal credits
- this is an early version of an agent economy where reliable publishers can get paid for useful event streams

The loop is simple:
- publish useful machine-readable events
- become discoverable to consumers
- accumulate credits when the network is funded

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
npm run setup
npm start
```

What `npm run setup` does:
- asks for your node name
- registers a publisher org on PushMe
- writes `.env` with your `PUSHME_API_KEY`
- sets a location slug for this machine
- seeds grouped default probe profiles
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
NETNODE_PROFILES_JSON=[{"name":"cloudflare-resolver","label":"Cloudflare Resolver","group":"resolver","targetHost":"1.1.1.1","targetUrl":"https://1.1.1.1/cdn-cgi/trace","dnsHost":"one.one.one.one"},{"name":"google-resolver","label":"Google Resolver","group":"resolver","targetHost":"8.8.8.8","targetUrl":"https://www.google.com/generate_204","dnsHost":"google.com"},{"name":"quad9-resolver","label":"Quad9 Resolver","group":"resolver","targetHost":"9.9.9.9","targetUrl":"https://www.quad9.net/","dnsHost":"dns.quad9.net"},{"name":"github-web","label":"GitHub Web","group":"web","targetHost":"github.com","targetUrl":"https://github.com/robots.txt","dnsHost":"github.com"},{"name":"wikipedia-web","label":"Wikipedia Web","group":"web","targetHost":"wikipedia.org","targetUrl":"https://www.wikipedia.org/","dnsHost":"wikipedia.org"},{"name":"example-web","label":"Example Web","group":"web","targetHost":"example.com","targetUrl":"https://example.com/","dnsHost":"example.com"},{"name":"openai-status-ai","label":"OpenAI Status","group":"ai","targetHost":"status.openai.com","targetUrl":"https://status.openai.com/api/v2/status.json","dnsHost":"status.openai.com","packetProbe":false,"providerStatusEnabled":true,"providerStatusAffectsSeverity":true},{"name":"anthropic-status-ai","label":"Anthropic Status","group":"ai","targetHost":"status.anthropic.com","targetUrl":"https://status.anthropic.com/api/v2/status.json","dnsHost":"status.anthropic.com","packetProbe":false,"providerStatusEnabled":true,"providerStatusAffectsSeverity":true}]
NETNODE_LOCATION=home-office
NETNODE_PACKET_COUNT=4
NETNODE_GROUP_THRESHOLDS_JSON={"resolver":{"dnsWarnMs":250,"httpWarnMs":1500,"httpDownMs":4500,"packetWarnPct":5,"packetDownPct":60},"web":{"dnsWarnMs":400,"httpWarnMs":2600,"httpDownMs":5500,"packetWarnPct":5,"packetDownPct":60},"ai":{"dnsWarnMs":300,"httpWarnMs":3000,"httpDownMs":6000,"packetWarnPct":100,"packetDownPct":100}}
NETNODE_INTERVAL_MS=60000
NETNODE_STATE_FILE=./netnode-state.json
NETNODE_PUBLISH_MODE=changes
```

Notes:
- `PUSHME_API_KEY` is created and written by `npm run setup`
- `NETNODE_PROFILES_JSON` is the main value-setting knob: each profile adds an independent destination and group
- `NETNODE_GROUP_THRESHOLDS_JSON` lets you tune sensitivity per group so `resolver`, `web`, and `ai` are not judged by the same latency bar
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
