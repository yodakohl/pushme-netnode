import dns from 'node:dns/promises';
import { spawn } from 'node:child_process';

export async function measureDnsLatency(hostname) {
  const startedAt = Date.now();
  await dns.resolve4(hostname);
  return Date.now() - startedAt;
}

export async function measureHttpLatency(url) {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': 'pushme-netnode/0.2'
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP probe failed with ${response.status}`);
  }
  await response.text();
  return Date.now() - startedAt;
}

function parsePingOutput(output, packetCount) {
  const packetMatch = output.match(/(\d+(?:\.\d+)?)%\s*packet loss/i);
  const avgMatch =
    output.match(/=\s*[\d.]+\/([\d.]+)\/[\d.]+\/[\d.]+\s*ms/) ||
    output.match(/Average = ([\d.]+)ms/i);
  return {
    packetLossPct: packetMatch ? Number(packetMatch[1]) : 100,
    avgLatencyMs: avgMatch ? Number(avgMatch[1]) : null,
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

export function classifyProfileConnectivity(metrics) {
  const failures = [];
  if (metrics.dnsError) failures.push('dns');
  if (metrics.httpError) failures.push('http');
  if (metrics.packetError) failures.push('packet');

  if (failures.length === 3) {
    return { severity: 'down', tags: ['network', 'down', 'probe-failure'] };
  }

  if (
    metrics.packetLossPct >= 60 ||
    (metrics.httpError && metrics.dnsError) ||
    (metrics.packetLossPct >= 30 && metrics.httpLatencyMs != null && metrics.httpLatencyMs >= 4000)
  ) {
    return { severity: 'down', tags: ['network', 'down', 'packet-loss'] };
  }

  if (
    metrics.packetLossPct >= 5 ||
    (metrics.dnsLatencyMs != null && metrics.dnsLatencyMs >= 250) ||
    (metrics.httpLatencyMs != null && metrics.httpLatencyMs >= 1200) ||
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
      avgDnsLatencyMs: null,
      avgHttpLatencyMs: null,
      avgPingLatencyMs: null,
      maxPacketLossPct: 0,
      impactedProfiles: []
    };
    entry.profileCount += 1;
    if (profile.severity !== 'ok') {
      entry.impactedCount += 1;
      entry.impactedProfiles.push(profile.name);
    }
    if (profile.severity === 'down') entry.downCount += 1;
    if (profile.severity === 'degraded') entry.degradedCount += 1;
    entry.maxPacketLossPct = Math.max(entry.maxPacketLossPct, Number(profile.packetLossPct ?? 0) || 0);
    groups.set(key, entry);
  }
  for (const entry of groups.values()) {
    const matching = profiles.filter((profile) => (profile.group || 'general') === entry.group);
    entry.avgDnsLatencyMs = mean(matching.map((profile) => profile.dnsLatencyMs));
    entry.avgHttpLatencyMs = mean(matching.map((profile) => profile.httpLatencyMs));
    entry.avgPingLatencyMs = mean(matching.map((profile) => profile.avgPingLatencyMs));
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
    .map((profile) => `${profile.name}:${profile.group || 'general'}:${profile.severity}:${profile.dnsError ? 'dns!' : ''}${profile.httpError ? 'http!' : ''}${profile.packetError ? 'ping!' : ''}`)
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
  return `${impacted.length}/${profiles.length} targets impacted: ${impacted
    .map((profile) => `${profile.label} ${profile.severity}`)
    .join(', ')}`;
}

function summarizeGroups(groupStats) {
  const impacted = groupStats.filter((group) => group.impactedCount > 0);
  if (!impacted.length) return 'All probe groups healthy';
  return impacted.map((group) => `${group.group} ${group.impactedCount}/${group.profileCount} impacted`).join(', ');
}

export function buildEventPayload(config, probeResult, previousState = {}) {
  const { measuredAt, profiles, classification, aggregate, groupStats, diagnosis } = probeResult;
  const previousSeverity = previousState.lastSeverity ?? null;
  const changed = previousSeverity && previousSeverity !== classification.severity;
  const eventType = classification.severity === 'ok' && changed ? 'net.connectivity.recovered' : classification.eventType;
  const titleSeverity = eventType === 'net.connectivity.recovered' ? 'recovered' : classification.severity;
  const impactedProfiles = profiles.filter((profile) => profile.severity !== 'ok').map((profile) => profile.name);
  const tags = new Set(classification.tags);
  if (eventType === 'net.connectivity.recovered') tags.add('recovered');
  impactedProfiles.forEach((profileName) => tags.add(profileName));
  diagnosis.impactedGroups.forEach((group) => tags.add(`group-${group}`));
  tags.add(config.location.toLowerCase().replace(/\s+/g, '-'));

  const summaryParts = [summarizeProfiles(profiles)];
  summaryParts.push(`diagnosis: ${diagnosis.label}`);
  summaryParts.push(summarizeGroups(groupStats));
  if (aggregate.avgDnsLatencyMs != null) summaryParts.push(`avg DNS ${aggregate.avgDnsLatencyMs} ms`);
  if (aggregate.avgHttpLatencyMs != null) summaryParts.push(`avg HTTP ${aggregate.avgHttpLatencyMs} ms`);
  if (aggregate.maxPacketLossPct != null) summaryParts.push(`max loss ${aggregate.maxPacketLossPct}%`);

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
      [`profile_${metadataKey(profile.name)}_packetLossPct`, profile.packetLossPct],
      [`profile_${metadataKey(profile.name)}_avgPingLatencyMs`, profile.avgPingLatencyMs],
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
      [`group_${metadataKey(group.group)}_avgDnsLatencyMs`, group.avgDnsLatencyMs],
      [`group_${metadataKey(group.group)}_avgHttpLatencyMs`, group.avgHttpLatencyMs],
      [`group_${metadataKey(group.group)}_avgPingLatencyMs`, group.avgPingLatencyMs],
      [`group_${metadataKey(group.group)}_maxPacketLossPct`, group.maxPacketLossPct],
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
      `Overall severity: ${classification.severity}`,
      `Scope: ${classification.scope}`,
      `Diagnosis: ${diagnosis.label}`,
      `Diagnosis summary: ${diagnosis.summary}`,
      `Impacted targets: ${classification.impactedCount}/${classification.profileCount}`,
      `Impacted groups: ${diagnosis.impactedGroups.join(', ') || 'none'}`,
      '',
      ...groupStats.flatMap((group) => [
        `Group: ${group.group}`,
        `- impacted targets: ${group.impactedCount}/${group.profileCount}`,
        `- degraded targets: ${group.degradedCount}`,
        `- down targets: ${group.downCount}`,
        group.avgDnsLatencyMs != null ? `- average DNS latency: ${group.avgDnsLatencyMs} ms` : null,
        group.avgHttpLatencyMs != null ? `- average HTTP latency: ${group.avgHttpLatencyMs} ms` : null,
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
        profile.packetLossPct != null ? `- Packet loss: ${profile.packetLossPct}%` : null,
        profile.avgPingLatencyMs != null ? `- Average ping latency: ${profile.avgPingLatencyMs} ms` : null,
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
      avgDnsLatencyMs: aggregate.avgDnsLatencyMs,
      avgHttpLatencyMs: aggregate.avgHttpLatencyMs,
      avgPingLatencyMs: aggregate.avgPingLatencyMs,
      maxPacketLossPct: aggregate.maxPacketLossPct,
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
          packetLossPct: profile.packetLossPct,
          avgPingLatencyMs: profile.avgPingLatencyMs,
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

async function runProfileProbe(profile, packetCount, measuredAt) {
  const packetProbeEnabled = profile.packetProbe !== false;
  const [dnsResult, httpResult, packetResult] = await Promise.allSettled([
    measureDnsLatency(profile.dnsHost),
    measureHttpLatency(profile.targetUrl),
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
    measuredAt,
    dnsLatencyMs: dnsResult.status === 'fulfilled' ? dnsResult.value : null,
    httpLatencyMs: httpResult.status === 'fulfilled' ? httpResult.value : null,
    packetLossPct: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.packetLossPct ?? null : 100) : null,
    avgPingLatencyMs: packetProbeEnabled ? (packetResult.status === 'fulfilled' ? packetResult.value?.avgLatencyMs ?? null : null) : null,
    dnsError: dnsResult.status === 'rejected' ? String(dnsResult.reason?.message ?? dnsResult.reason ?? 'DNS probe failed') : null,
    httpError: httpResult.status === 'rejected' ? String(httpResult.reason?.message ?? httpResult.reason ?? 'HTTP probe failed') : null,
    packetError:
      packetProbeEnabled && packetResult.status === 'rejected'
        ? String(packetResult.reason?.message ?? packetResult.reason ?? 'Ping probe failed')
        : null
  };

  const classification = classifyProfileConnectivity(metrics);
  return {
    ...metrics,
    severity: classification.severity,
    tags: classification.tags
  };
}

export async function runProbe(config) {
  const measuredAt = new Date().toISOString();
  const profiles = await Promise.all(
    (config.profiles || []).map((profile) => runProfileProbe(profile, config.packetCount, measuredAt))
  );
  const classification = classifyConnectivity(profiles);
  const groupStats = buildGroupStats(profiles);
  const diagnosis = deriveDiagnosis(profiles, groupStats, classification);
  const aggregate = {
    avgDnsLatencyMs: mean(profiles.map((profile) => profile.dnsLatencyMs)),
    avgHttpLatencyMs: mean(profiles.map((profile) => profile.httpLatencyMs)),
    avgPingLatencyMs: mean(profiles.map((profile) => profile.avgPingLatencyMs)),
    maxPacketLossPct: profiles.reduce((max, profile) => Math.max(max, Number(profile.packetLossPct ?? 0) || 0), 0)
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
