import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { buildUserAgent } from './runtime.mjs';

export async function measureDnsLatency(hostname) {
  const startedAt = Date.now();
  await dns.resolve4(hostname);
  return Date.now() - startedAt;
}

function byteLength(text) {
  return new TextEncoder().encode(String(text ?? '')).length;
}

function mapProviderStatusSeverity(indicator) {
  const normalized = String(indicator ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'none') return null;
  if (normalized === 'minor' || normalized === 'maintenance') return 'degraded';
  if (normalized === 'major' || normalized === 'critical') return 'down';
  return 'degraded';
}

function parseProviderStatus(bodyText, contentType) {
  if (!/json/i.test(String(contentType ?? ''))) return null;
  try {
    const payload = JSON.parse(bodyText);
    const indicator = payload?.status?.indicator ?? payload?.indicator ?? null;
    const description = payload?.status?.description ?? payload?.description ?? null;
    const severity = mapProviderStatusSeverity(indicator);
    if (!indicator && !description) return null;
    return {
      indicator: indicator ? String(indicator) : null,
      description: description ? String(description) : null,
      severity
    };
  } catch {
    return null;
  }
}

export async function measureHttpProbe(url, profile = {}) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': buildUserAgent(profile.nodeVersion)
    }
  });
  const bodyText = await response.text();
  const contentType = response.headers.get('content-type') ?? null;
  const contentLengthHeader = response.headers.get('content-length');
  const contentLengthBytes = Number.isFinite(Number(contentLengthHeader))
    ? Number(contentLengthHeader)
    : byteLength(bodyText);
  const providerStatus = profile.providerStatusEnabled ? parseProviderStatus(bodyText, contentType) : null;
  if (!response.ok) {
    throw new Error(`HTTP probe failed with ${response.status}`);
  }
  return {
    latencyMs: Date.now() - startedAt,
    statusCode: response.status,
    contentType,
    contentLengthBytes,
    providerStatusIndicator: providerStatus?.indicator ?? null,
    providerStatusDescription: providerStatus?.description ?? null,
    providerStatusSeverity: providerStatus?.severity ?? null
  };
}

function parsePingOutput(output, packetCount) {
  const packetMatch = output.match(/(\d+(?:\.\d+)?)%\s*packet loss/i);
  const linuxRttMatch = output.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  const windowsAvgMatch = output.match(/Average = ([\d.]+)ms/i);
  const windowsMinMatch = output.match(/Minimum = ([\d.]+)ms/i);
  const windowsMaxMatch = output.match(/Maximum = ([\d.]+)ms/i);
  return {
    packetLossPct: packetMatch ? Number(packetMatch[1]) : 100,
    minLatencyMs: linuxRttMatch ? Number(linuxRttMatch[1]) : windowsMinMatch ? Number(windowsMinMatch[1]) : null,
    avgLatencyMs: linuxRttMatch ? Number(linuxRttMatch[2]) : windowsAvgMatch ? Number(windowsAvgMatch[1]) : null,
    maxLatencyMs: linuxRttMatch ? Number(linuxRttMatch[3]) : windowsMaxMatch ? Number(windowsMaxMatch[1]) : null,
    jitterMs: linuxRttMatch ? Number(linuxRttMatch[4]) : null,
    packetsSent: packetCount
  };
}

export async function measurePacketLoss(host, packetCount) {
  const args = ['-c', String(packetCount), '-n', host];
  const result = await new Promise((resolve, reject) => {
    const child = spawn('ping', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (typeof result.code !== 'number') {
    throw new Error('Ping command did not exit cleanly');
  }
  if (result.code !== 0 && !/packet loss/i.test(combined)) {
    throw new Error(`Ping failed: ${combined.trim() || result.code}`);
  }
  return parsePingOutput(combined, packetCount);
}

export function classifyProfileConnectivity(metrics, thresholds = {}) {
  const failures = [];
  if (metrics.dnsError) failures.push('dns');
  if (metrics.httpError) failures.push('http');
  if (metrics.packetError) failures.push('packet');
  if (metrics.providerStatusSeverity) failures.push(`provider-${metrics.providerStatusSeverity}`);
  const dnsWarnMs = Number.isFinite(Number(thresholds.dnsWarnMs)) ? Number(thresholds.dnsWarnMs) : 250;
  const httpWarnMs = Number.isFinite(Number(thresholds.httpWarnMs)) ? Number(thresholds.httpWarnMs) : 1200;
  const httpDownMs = Number.isFinite(Number(thresholds.httpDownMs)) ? Number(thresholds.httpDownMs) : 4000;
  const packetWarnPct = Number.isFinite(Number(thresholds.packetWarnPct)) ? Number(thresholds.packetWarnPct) : 5;
  const packetDownPct = Number.isFinite(Number(thresholds.packetDownPct)) ? Number(thresholds.packetDownPct) : 60;

  if (failures.length === 3) {
    return { severity: 'down', tags: ['network', 'down', 'probe-failure'] };
  }

  if (metrics.providerStatusAffectsSeverity && metrics.providerStatusSeverity === 'down') {
    return { severity: 'down', tags: ['network', 'down', 'provider-status'] };
  }

  if (metrics.providerStatusAffectsSeverity && metrics.providerStatusSeverity === 'degraded') {
    return { severity: 'degraded', tags: ['network', 'degraded', 'provider-status'] };
  }

  if (
    metrics.packetLossPct >= packetDownPct ||
    (metrics.httpError && metrics.dnsError) ||
    (metrics.packetLossPct >= Math.max(packetWarnPct, 30) && metrics.httpLatencyMs != null && metrics.httpLatencyMs >= httpDownMs)
  ) {
    return { severity: 'down', tags: ['network', 'down', 'packet-loss'] };
  }

  if (
    metrics.packetLossPct >= packetWarnPct ||
    (metrics.dnsLatencyMs != null && metrics.dnsLatencyMs >= dnsWarnMs) ||
    (metrics.httpLatencyMs != null && metrics.httpLatencyMs >= httpWarnMs) ||
    failures.length > 0
  ) {
    return { severity: 'degraded', tags: ['network', 'degraded', 'latency'] };
  }

  return { severity: 'ok', tags: ['network', 'healthy'] };
}

function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return Math.round((usable.reduce((sum, value) => sum + value, 0) / usable.length) * 1000) / 1000;
}

function metadataKey(value) {
  return String(value || 'general').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'general';
}

function buildGroupStats(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    const key = profile.group || 'general';
    const entry = groups.get(key) || {
      group: key,
      profileCount: 0,
      impactedCount: 0,
      downCount: 0,
      degradedCount: 0,
      providerReportedCount: 0,
      avgDnsLatencyMs: null,
      avgHttpLatencyMs: null,
      avgPingLatencyMs: null,
      avgJitterMs: null,
      maxPacketLossPct: 0,
      maxJitterMs: 0,
      impactedProfiles: []
    };
    entry.profileCount += 1;
    if (profile.severity !== 'ok') {
      entry.impactedCount += 1;
      entry.impactedProfiles.push(profile.name);
    }
    if (profile.severity === 'down') entry.downCount += 1;
    if (profile.severity === 'degraded') entry.degradedCount += 1;
    if (profile.providerStatusSeverity) entry.providerReportedCount += 1;
    entry.maxPacketLossPct = Math.max(entry.maxPacketLossPct, Number(profile.packetLossPct ?? 0) || 0);
    entry.maxJitterMs = Math.max(entry.maxJitterMs, Number(profile.packetJitterMs ?? 0) || 0);
    groups.set(key, entry);
  }
  for (const entry of groups.values()) {
    const matching = profiles.filter((profile) => (profile.group || 'general') === entry.group);
    entry.avgDnsLatencyMs = mean(matching.map((profile) => profile.dnsLatencyMs));
    entry.avgHttpLatencyMs = mean(matching.map((profile) => profile.httpLatencyMs));
    entry.avgPingLatencyMs = mean(matching.map((profile) => profile.avgPingLatencyMs));
    entry.avgJitterMs = mean(matching.map((profile) => profile.packetJitterMs));
  }
  return Array.from(groups.values()).sort((a, b) => a.group.localeCompare(b.group));
}

export function deriveDiagnosis(profiles, groupStats, classification) {
  const impactedGroups = groupStats.filter((group) => group.impactedCount > 0).map((group) => group.group);
  const totalGroups = groupStats.length;
  const resolver = groupStats.find((group) => group.group === 'resolver');
  const web = groupStats.find((group) => group.group === 'web');
  const ai = groupStats.find((group) => group.group === 'ai');

  if (classification.impactedCount === 0) {
    return {
      code: 'healthy',
      label: 'healthy connectivity',
      summary: 'All configured probe groups are healthy.',
      impactedGroups
    };
  }

  if (
    ai &&
    ai.providerReportedCount > 0 &&
    ai.impactedCount === ai.providerReportedCount &&
    (!resolver || resolver.impactedCount === 0) &&
    (!web || web.impactedCount === 0)
  ) {
    return {
      code: 'ai-platform-incident-reported',
      label: 'AI platform incident reported',
      summary: 'AI status endpoints are reachable but currently report platform-side degradation.',
      impactedGroups
    };
  }

  if (resolver && resolver.impactedCount === resolver.profileCount && (!web || web.impactedCount === 0)) {
    return {
      code: 'resolver-reachability-issue',
      label: 'resolver reachability issue',
      summary: 'DNS resolver paths are degraded while general web destinations still look healthy.',
      impactedGroups
    };
  }

  if (web && web.impactedCount === web.profileCount && (!resolver || resolver.impactedCount === 0) && (!ai || ai.impactedCount === 0)) {
    return {
      code: 'web-egress-issue',
      label: 'web egress issue',
      summary: 'Web destinations are degraded while resolver paths still look healthy.',
      impactedGroups
    };
  }

  if (ai && ai.impactedCount === ai.profileCount && (!resolver || resolver.impactedCount === 0) && (!web || web.impactedCount === 0)) {
    return {
      code: 'ai-platform-access-issue',
      label: 'AI platform access issue',
      summary: 'AI platform endpoints are degraded while generic resolver and web groups still look healthy.',
      impactedGroups
    };
  }

  if (impactedGroups.length >= 2 || impactedGroups.length === totalGroups) {
    return {
      code: 'broad-connectivity-issue',
      label: 'broad connectivity issue',
      summary: 'Multiple probe groups are impacted, suggesting an upstream or wider network issue.',
      impactedGroups
    };
  }

  if (classification.scope === 'localized') {
    return {
      code: 'single-destination-anomaly',
      label: 'single destination anomaly',
      summary: 'Only one destination is degraded, which usually points to a provider-specific issue rather than local outage.',
      impactedGroups
    };
  }

  return {
    code: 'mixed-connectivity-issue',
    label: 'mixed connectivity issue',
    summary: 'Some destinations are impacted, but the failure pattern does not map cleanly to one probe group.',
    impactedGroups
  };
}

export function classifyConnectivity(profiles) {
  const profileCount = profiles.length;
  const downCount = profiles.filter((profile) => profile.severity === 'down').length;
  const degradedCount = profiles.filter((profile) => profile.severity === 'degraded').length;
  const impactedCount = downCount + degradedCount;
  const okCount = profileCount - impactedCount;
  const scope =
    impactedCount === 0
      ? 'healthy'
      : impactedCount === 1
        ? 'localized'
        : impactedCount === profileCount
          ? 'global'
          : 'partial';

  if (profileCount > 0 && downCount >= Math.ceil(profileCount / 2)) {
    return {
      severity: 'down',
      eventType: 'net.connectivity.down',
      tags: ['network', 'down', scope === 'global' ? 'global-outage' : 'multi-target-outage'],
      scope,
      profileCount,
      downCount,
      degradedCount,
      okCount,
      impactedCount
    };
  }

  if (impactedCount > 0) {
    return {
      severity: 'degraded',
      eventType: 'net.connectivity.degraded',
      tags: ['network', 'degraded', scope === 'localized' ? 'single-target-issue' : 'multi-target-issue'],
      scope,
      profileCount,
      downCount,
      degradedCount,
      okCount,
      impactedCount
    };
  }

  return {
    severity: 'ok',
    eventType: 'net.connectivity.ok',
    tags: ['network', 'healthy', 'multi-target-ok'],
    scope,
    profileCount,
    downCount,
    degradedCount,
    okCount,
    impactedCount
  };
}

export function createStatusFingerprint(profiles, classification, diagnosis = null) {
  const profilePart = profiles
    .map(
      (profile) =>
        `${profile.name}:${profile.group || 'general'}:${profile.severity}:${profile.providerStatusSeverity || 'none'}:${profile.httpStatusCode || 'na'}:${profile.dnsError ? 'dns!' : ''}${profile.httpError ? 'http!' : ''}${profile.packetError ? 'ping!' : ''}`
    )
    .sort()
    .join('|');
  const diagnosisPart = diagnosis?.code ?? 'unknown';
  return `${classification.severity}:${classification.scope}:${diagnosisPart}:${classification.impactedCount}/${classification.profileCount}:${profilePart}`;
}

function summarizeProfiles(profiles) {
  const impacted = profiles.filter((profile) => profile.severity !== 'ok');
  if (!impacted.length) {
    return `All ${profiles.length}/${profiles.length} probe targets healthy`;
  }
  return `${impacted.length}/${profiles.length} targets impacted: ${impacted.map((profile) => `${profile.label} ${profile.severity}`).join(', ')}`;
}

function summarizeGroups(groupStats) {
  const impacted = groupStats.filter((group) => group.impactedCount > 0);
  if (!impacted.length) return 'All probe groups healthy';
  return impacted
    .map(
      (group) => `${group.group} ${group.impactedCount}/${group.profileCount} impacted${group.providerReportedCount ? `, provider-reported ${group.providerReportedCount}` : ''}`
    )
    .join(', ');
}

export function buildEventPayload(config, probeResult, previousState = {}) {
  const { measuredAt, profiles, classification, aggregate, groupStats, diagnosis } = probeResult;
  const previousSeverity = previousState.lastSeverity ?? null;
  const changed = previousSeverity && previousSeverity !== classification.severity;
  const eventType = classification.severity === 'ok' && changed ? 'net.connectivity.recovered' : classification.eventType;
  const titleSeverity = eventType === 'net.connectivity.recovered' ? 'recovered' : classification.severity;
  const impactedProfiles = profiles.filter((profile) => profile.severity !== 'ok').map((profile) => profile.name);
  const tags = new Set(classification.tags);
  const identity = config.nodeIdentity || {};
  if (eventType === 'net.connectivity.recovered') tags.add('recovered');
  impactedProfiles.forEach((profileName) => tags.add(profileName));
  diagnosis.impactedGroups.forEach((group) => tags.add(`group-${group}`));
  if (profiles.some((profile) => profile.providerStatusSeverity)) tags.add('provider-status');
  tags.add(config.location.toLowerCase().replace(/\s+/g, '-'));
  if (identity.countryCode) tags.add(`country-${String(identity.countryCode).toLowerCase()}`);
  if (identity.networkType) tags.add(`network-${metadataKey(identity.networkType)}`);
  if (identity.provider) tags.add(`provider-${metadataKey(identity.provider)}`);
  if (identity.asn) tags.add(`asn-${identity.asn}`);

  const summaryParts = [summarizeProfiles(profiles)];
  summaryParts.push(`diagnosis: ${diagnosis.label}`);
  summaryParts.push(summarizeGroups(groupStats));
  if (aggregate.avgDnsLatencyMs != null) summaryParts.push(`avg DNS ${aggregate.avgDnsLatencyMs} ms`);
  if (aggregate.avgHttpLatencyMs != null) summaryParts.push(`avg HTTP ${aggregate.avgHttpLatencyMs} ms`);
  if (aggregate.avgJitterMs != null) summaryParts.push(`avg jitter ${aggregate.avgJitterMs} ms`);
  if (aggregate.maxPacketLossPct != null) summaryParts.push(`max loss ${aggregate.maxPacketLossPct}%`);
  if (aggregate.totalHttpResponseBytes != null) summaryParts.push(`HTTP ${aggregate.totalHttpResponseBytes} B`);
  if (aggregate.totalPingPacketsSent != null) summaryParts.push(`ICMP ${aggregate.totalPingPacketsSent} pkts`);

  const flattenedProfileMetadata = Object.fromEntries(
    profiles.flatMap((profile) => [
      [`profile_${metadataKey(profile.name)}_label`, profile.label],
      [`profile_${metadataKey(profile.name)}_group`, profile.group || 'general'],
      [`profile_${metadataKey(profile.name)}_severity`, profile.severity],
      [`profile_${metadataKey(profile.name)}_targetHost`, profile.targetHost],
      [`profile_${metadataKey(profile.name)}_targetUrl`, profile.targetUrl],
      [`profile_${metadataKey(profile.name)}_dnsHost`, profile.dnsHost],
      [`profile_${metadataKey(profile.name)}_packetProbeEnabled`, profile.packetProbeEnabled],
      [`profile_${metadataKey(profile.name)}_dnsLatencyMs`, profile.dnsLatencyMs],
      [`profile_${metadataKey(profile.name)}_httpLatencyMs`, profile.httpLatencyMs],
      [`profile_${metadataKey(profile.name)}_httpStatusCode`, profile.httpStatusCode],
      [`profile_${metadataKey(profile.name)}_httpContentType`, profile.httpContentType],
      [`profile_${metadataKey(profile.name)}_httpResponseBytes`, profile.httpResponseBytes],
      [`profile_${metadataKey(profile.name)}_packetPacketsSent`, profile.packetPacketsSent],
      [`profile_${metadataKey(profile.name)}_packetLossPct`, profile.packetLossPct],
      [`profile_${metadataKey(profile.name)}_packetMinLatencyMs`, profile.packetMinLatencyMs],
      [`profile_${metadataKey(profile.name)}_avgPingLatencyMs`, profile.avgPingLatencyMs],
      [`profile_${metadataKey(profile.name)}_packetMaxLatencyMs`, profile.packetMaxLatencyMs],
      [`profile_${metadataKey(profile.name)}_packetJitterMs`, profile.packetJitterMs],
      [`profile_${metadataKey(profile.name)}_providerStatusIndicator`, profile.providerStatusIndicator],
      [`profile_${metadataKey(profile.name)}_providerStatusDescription`, profile.providerStatusDescription],
      [`profile_${metadataKey(profile.name)}_providerStatusSeverity`, profile.providerStatusSeverity],
      [`profile_${metadataKey(profile.name)}_dnsWarnMs`, profile.thresholds?.dnsWarnMs ?? null],
      [`profile_${metadataKey(profile.name)}_httpWarnMs`, profile.thresholds?.httpWarnMs ?? null],
      [`profile_${metadataKey(profile.name)}_httpDownMs`, profile.thresholds?.httpDownMs ?? null],
      [`profile_${metadataKey(profile.name)}_dnsError`, profile.dnsError],
      [`profile_${metadataKey(profile.name)}_httpError`, profile.httpError],
      [`profile_${metadataKey(profile.name)}_packetError`, profile.packetError]
    ])
  );

  const flattenedGroupMetadata = Object.fromEntries(
    groupStats.flatMap((group) => [
      [`group_${metadataKey(group.group)}_profileCount`, group.profileCount],
      [`group_${metadataKey(group.group)}_impactedCount`, group.impactedCount],
      [`group_${metadataKey(group.group)}_downCount`, group.downCount],
      [`group_${metadataKey(group.group)}_degradedCount`, group.degradedCount],
      [`group_${metadataKey(group.group)}_providerReportedCount`, group.providerReportedCount],
      [`group_${metadataKey(group.group)}_avgDnsLatencyMs`, group.avgDnsLatencyMs],
      [`group_${metadataKey(group.group)}_avgHttpLatencyMs`, group.avgHttpLatencyMs],
      [`group_${metadataKey(group.group)}_avgPingLatencyMs`, group.avgPingLatencyMs],
      [`group_${metadataKey(group.group)}_avgJitterMs`, group.avgJitterMs],
      [`group_${metadataKey(group.group)}_maxPacketLossPct`, group.maxPacketLossPct],
      [`group_${metadataKey(group.group)}_maxJitterMs`, group.maxJitterMs],
      [`group_${metadataKey(group.group)}_impactedProfilesCsv`, group.impactedProfiles.join(',')]
    ])
  );

  return {
    eventType,
    topic: `${config.location} connectivity`,
    title: `Connectivity ${titleSeverity} at ${config.location}`,
    summary: summaryParts.join(', '),
    body: [
      `Location: ${config.location}`,
      identity.country || identity.countryCode || identity.provider || identity.asn
        ? `Node identity: ${[
            identity.city,
            identity.region,
            identity.country || identity.countryCode,
            identity.provider,
            identity.asn ? `AS${identity.asn}` : null,
            identity.networkType
          ]
            .filter(Boolean)
            .join(' · ')}`
        : null,
      `Overall severity: ${classification.severity}`,
      `Scope: ${classification.scope}`,
      `Diagnosis: ${diagnosis.label}`,
      `Diagnosis summary: ${diagnosis.summary}`,
      `Impacted targets: ${classification.impactedCount}/${classification.profileCount}`,
      `Impacted groups: ${diagnosis.impactedGroups.join(', ') || 'none'}`,
      `Observed HTTP response bytes: ${aggregate.totalHttpResponseBytes}`,
      `ICMP packets sent: ${aggregate.totalPingPacketsSent}`,
      '',
      ...groupStats.flatMap((group) => [
        `Group: ${group.group}`,
        `- impacted targets: ${group.impactedCount}/${group.profileCount}`,
        `- degraded targets: ${group.degradedCount}`,
        `- down targets: ${group.downCount}`,
        group.providerReportedCount ? `- provider-reported incidents: ${group.providerReportedCount}` : null,
        group.avgDnsLatencyMs != null ? `- average DNS latency: ${group.avgDnsLatencyMs} ms` : null,
        group.avgHttpLatencyMs != null ? `- average HTTP latency: ${group.avgHttpLatencyMs} ms` : null,
        group.avgJitterMs != null ? `- average jitter: ${group.avgJitterMs} ms` : null,
        group.maxPacketLossPct != null ? `- max packet loss: ${group.maxPacketLossPct}%` : null,
        group.impactedProfiles.length ? `- impacted profiles: ${group.impactedProfiles.join(', ')}` : null,
        ''
      ]),
      ...profiles.flatMap((profile) => [
        `Profile: ${profile.label} (${profile.name})`,
        `- group: ${profile.group || 'general'}`,
        `- target host: ${profile.targetHost}`,
        `- target URL: ${profile.targetUrl}`,
        `- DNS host: ${profile.dnsHost}`,
        `- severity: ${profile.severity}`,
        profile.dnsLatencyMs != null ? `- DNS latency: ${profile.dnsLatencyMs} ms` : null,
        profile.httpLatencyMs != null ? `- HTTP latency: ${profile.httpLatencyMs} ms` : null,
        profile.httpStatusCode != null ? `- HTTP status: ${profile.httpStatusCode}` : null,
        profile.httpResponseBytes != null ? `- HTTP response bytes: ${profile.httpResponseBytes}` : null,
        profile.packetPacketsSent ? `- ICMP packets sent: ${profile.packetPacketsSent}` : null,
        profile.packetLossPct != null ? `- Packet loss: ${profile.packetLossPct}%` : null,
        profile.packetMinLatencyMs != null ? `- Min ping latency: ${profile.packetMinLatencyMs} ms` : null,
        profile.avgPingLatencyMs != null ? `- Average ping latency: ${profile.avgPingLatencyMs} ms` : null,
        profile.packetMaxLatencyMs != null ? `- Max ping latency: ${profile.packetMaxLatencyMs} ms` : null,
        profile.packetJitterMs != null ? `- Ping jitter: ${profile.packetJitterMs} ms` : null,
        profile.providerStatusIndicator ? `- Provider status: ${profile.providerStatusIndicator}${profile.providerStatusDescription ? ` (${profile.providerStatusDescription})` : ''}` : null,
        profile.dnsError ? `- DNS error: ${profile.dnsError}` : null,
        profile.httpError ? `- HTTP error: ${profile.httpError}` : null,
        profile.packetError ? `- Packet probe error: ${profile.packetError}` : null,
        ''
      ]),
      `Measured at: ${measuredAt}`
    ]
      .filter(Boolean)
      .join('\n'),
    sourceUrl: config.sourceUrl || profiles[0]?.targetUrl || undefined,
    externalId: `${config.location}-${eventType}-${measuredAt}`,
    tags: Array.from(tags).slice(0, 12),
    metadata: {
      location: config.location,
      nodeCountryCode: identity.countryCode ?? null,
      nodeCountry: identity.country ?? null,
      nodeRegion: identity.region ?? null,
      nodeCity: identity.city ?? null,
      nodeProvider: identity.provider ?? null,
      nodeProviderDomain: identity.providerDomain ?? null,
      nodeAsn: identity.asn ?? null,
      nodeNetworkType: identity.networkType ?? null,
      nodeIdentitySource: identity.source ?? null,
      nodeVersion: config.nodeVersion ?? null,
      releaseChannel: config.releaseChannel ?? null,
      image: config.image ?? null,
      stateSchemaVersion: previousState.schemaVersion ?? null,
      packetCount: config.packetCount,
      severity: classification.severity,
      previousSeverity,
      measuredAt,
      scope: classification.scope,
      diagnosisCode: diagnosis.code,
      diagnosisLabel: diagnosis.label,
      diagnosisSummary: diagnosis.summary,
      groupCount: groupStats.length,
      impactedGroupsCsv: diagnosis.impactedGroups.join(','),
      profileCount: classification.profileCount,
      impactedProfileCount: classification.impactedCount,
      impactedProfilesCsv: impactedProfiles.join(','),
      providerReportedProfileCount: profiles.filter((profile) => profile.providerStatusSeverity).length,
      avgDnsLatencyMs: aggregate.avgDnsLatencyMs,
      avgHttpLatencyMs: aggregate.avgHttpLatencyMs,
      avgPingLatencyMs: aggregate.avgPingLatencyMs,
      avgJitterMs: aggregate.avgJitterMs,
      maxPacketLossPct: aggregate.maxPacketLossPct,
      totalHttpResponseBytes: aggregate.totalHttpResponseBytes,
      totalPingPacketsSent: aggregate.totalPingPacketsSent,
      dnsProbeCount: aggregate.dnsProbeCount,
      httpProbeCount: aggregate.httpProbeCount,
      packetProbeTargetCount: aggregate.packetProbeTargetCount,
      groupStatsJson: JSON.stringify(groupStats),
      profilesJson: JSON.stringify(
        profiles.map((profile) => ({
          name: profile.name,
          label: profile.label,
          group: profile.group || 'general',
          severity: profile.severity,
          targetHost: profile.targetHost,
          targetUrl: profile.targetUrl,
          dnsHost: profile.dnsHost,
          packetProbeEnabled: profile.packetProbeEnabled,
          dnsLatencyMs: profile.dnsLatencyMs,
          httpLatencyMs: profile.httpLatencyMs,
          httpStatusCode: profile.httpStatusCode,
          httpContentType: profile.httpContentType,
          httpResponseBytes: profile.httpResponseBytes,
          packetPacketsSent: profile.packetPacketsSent,
          packetLossPct: profile.packetLossPct,
          packetMinLatencyMs: profile.packetMinLatencyMs,
          avgPingLatencyMs: profile.avgPingLatencyMs,
          packetMaxLatencyMs: profile.packetMaxLatencyMs,
          packetJitterMs: profile.packetJitterMs,
          providerStatusIndicator: profile.providerStatusIndicator,
          providerStatusDescription: profile.providerStatusDescription,
          providerStatusSeverity: profile.providerStatusSeverity,
          thresholds: profile.thresholds,
          dnsError: profile.dnsError,
          httpError: profile.httpError,
          packetError: profile.packetError
        }))
      ),
      ...flattenedGroupMetadata,
      ...flattenedProfileMetadata
    }
  };
}

async function runProfileProbe(profile, packetCount, measuredAt, groupThresholds = {}) {
  const packetProbeEnabled = profile.packetProbe !== false;
  const [dnsResult, httpResult, packetResult] = await Promise.allSettled([
    measureDnsLatency(profile.dnsHost),
    measureHttpProbe(profile.targetUrl, profile),
    packetProbeEnabled ? measurePacketLoss(profile.targetHost, packetCount) : Promise.resolve(null)
  ]);

  const metrics = {
    name: profile.name,
    label: profile.label,
    group: profile.group || 'general',
    targetHost: profile.targetHost,
    targetUrl: profile.targetUrl,
    dnsHost: profile.dnsHost,
    packetProbeEnabled,
    providerStatusAffectsSeverity: profile.providerStatusAffectsSeverity !== false,
    thresholds: profile.thresholds || groupThresholds[profile.group || 'general'] || groupThresholds.general || null,
    measuredAt,
    dnsLatencyMs: dnsResult.status === 'fulfilled' ? dnsResult.value : null,
    httpLatencyMs: httpResult.status === 'fulfilled' ? httpResult.value?.latencyMs ?? null : null,
    httpStatusCode: httpResult.status === 'fulfilled' ? httpResult.value?.statusCode ?? null : null,
    httpContentType: httpResult.status === 'fulfilled' ? httpResult.value?.contentType ?? null : null,
    httpResponseBytes: httpResult.status === 'fulfilled' ? httpResult.value?.contentLengthBytes ?? null : null,
    providerStatusIndicator: httpResult.status === 'fulfilled' ? httpResult.value?.providerStatusIndicator ?? null : null,
    providerStatusDescription: httpResult.status === 'fulfilled' ? httpResult.value?.providerStatusDescription ?? null : null,
    providerStatusSeverity: httpResult.status === 'fulfilled' ? httpResult.value?.providerStatusSeverity ?? null : null,
    packetLossPct: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.packetLossPct ?? null : 100) : null,
    packetPacketsSent: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.packetsSent ?? packetCount : packetCount) : 0,
    packetMinLatencyMs: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.minLatencyMs ?? null : null) : null,
    avgPingLatencyMs: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.avgLatencyMs ?? null : null) : null,
    packetMaxLatencyMs: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.maxLatencyMs ?? null : null) : null,
    packetJitterMs: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.jitterMs ?? null : null) : null,
    dnsError: dnsResult.status === 'rejected' ? String(dnsResult.reason?.message ?? dnsResult.reason ?? 'DNS probe failed') : null,
    httpError: httpResult.status === 'rejected' ? String(httpResult.reason?.message ?? httpResult.reason ?? 'HTTP probe failed') : null,
    packetError:
      packetProbeEnabled && packetResult.status === 'rejected'
        ? String(packetResult.reason?.message ?? packetResult.reason ?? 'Ping probe failed')
        : null
  };

  const classification = classifyProfileConnectivity(metrics, metrics.thresholds);
  return {
    ...metrics,
    severity: classification.severity,
    tags: classification.tags
  };
}

export async function runProbe(config) {
  const measuredAt = new Date().toISOString();
  const profiles = await Promise.all(
    (config.profiles || []).map((profile) => runProfileProbe(profile, config.packetCount, measuredAt, config.groupThresholds || {}))
  );
  const classification = classifyConnectivity(profiles);
  const groupStats = buildGroupStats(profiles);
  const diagnosis = deriveDiagnosis(profiles, groupStats, classification);
  const aggregate = {
    avgDnsLatencyMs: mean(profiles.map((profile) => profile.dnsLatencyMs)),
    avgHttpLatencyMs: mean(profiles.map((profile) => profile.httpLatencyMs)),
    avgPingLatencyMs: mean(profiles.map((profile) => profile.avgPingLatencyMs)),
    avgJitterMs: mean(profiles.map((profile) => profile.packetJitterMs)),
    maxPacketLossPct: profiles.reduce((max, profile) => Math.max(max, Number(profile.packetLossPct ?? 0) || 0), 0),
    totalHttpResponseBytes: profiles.reduce((sum, profile) => sum + (Number(profile.httpResponseBytes ?? 0) || 0), 0),
    totalPingPacketsSent: profiles.reduce((sum, profile) => sum + (Number(profile.packetPacketsSent ?? 0) || 0), 0),
    dnsProbeCount: profiles.length,
    httpProbeCount: profiles.length,
    packetProbeTargetCount: profiles.filter((profile) => profile.packetProbeEnabled).length
  };
  return {
    measuredAt,
    profiles,
    aggregate,
    classification,
    groupStats,
    diagnosis,
    fingerprint: createStatusFingerprint(profiles, classification, diagnosis)
  };
}
