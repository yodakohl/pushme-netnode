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
      'user-agent': 'pushme-netnode/0.1'
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

export function classifyConnectivity(metrics) {
  const failures = [];
  if (metrics.dnsError) failures.push('dns');
  if (metrics.httpError) failures.push('http');
  if (metrics.packetError) failures.push('packet');

  if (failures.length === 3) {
    return { severity: 'down', eventType: 'net.connectivity.down', tags: ['network', 'down', 'probe-failure'] };
  }

  if (
    metrics.packetLossPct >= 60 ||
    (metrics.httpError && metrics.dnsError) ||
    (metrics.packetLossPct >= 30 && metrics.httpLatencyMs != null && metrics.httpLatencyMs >= 4000)
  ) {
    return { severity: 'down', eventType: 'net.connectivity.down', tags: ['network', 'down', 'packet-loss'] };
  }

  if (
    metrics.packetLossPct >= 5 ||
    (metrics.dnsLatencyMs != null && metrics.dnsLatencyMs >= 250) ||
    (metrics.httpLatencyMs != null && metrics.httpLatencyMs >= 1200) ||
    failures.length > 0
  ) {
    return { severity: 'degraded', eventType: 'net.connectivity.degraded', tags: ['network', 'degraded', 'latency'] };
  }

  return { severity: 'ok', eventType: 'net.connectivity.ok', tags: ['network', 'healthy'] };
}

export function buildEventPayload(config, metrics, classification, previousSeverity) {
  const topic = `${config.location} connectivity`;
  const changed = previousSeverity && previousSeverity !== classification.severity;
  const eventType =
    classification.severity === 'ok' && changed ? 'net.connectivity.recovered' : classification.eventType;
  const titleSeverity =
    eventType === 'net.connectivity.recovered'
      ? 'recovered'
      : classification.severity;
  const tags = new Set(classification.tags);
  if (eventType === 'net.connectivity.recovered') {
    tags.add('recovered');
  }
  const title = `Connectivity ${titleSeverity} at ${config.location}`;
  const summaryBits = [];
  if (metrics.dnsLatencyMs != null) summaryBits.push(`DNS ${metrics.dnsLatencyMs} ms`);
  if (metrics.httpLatencyMs != null) summaryBits.push(`HTTP ${metrics.httpLatencyMs} ms`);
  if (metrics.packetLossPct != null) summaryBits.push(`packet loss ${metrics.packetLossPct}%`);
  if (metrics.dnsError) summaryBits.push(`DNS error: ${metrics.dnsError}`);
  if (metrics.httpError) summaryBits.push(`HTTP error: ${metrics.httpError}`);
  if (metrics.packetError) summaryBits.push(`packet probe error: ${metrics.packetError}`);

  return {
    eventType,
    topic,
    title,
    summary: summaryBits.join(', '),
    body: [
      `Location: ${config.location}`,
      `Severity: ${classification.severity}`,
      `Target host: ${config.targetHost}`,
      `Target URL: ${config.targetUrl}`,
      `DNS host: ${config.dnsHost}`,
      metrics.dnsLatencyMs != null ? `DNS latency: ${metrics.dnsLatencyMs} ms` : null,
      metrics.httpLatencyMs != null ? `HTTP latency: ${metrics.httpLatencyMs} ms` : null,
      metrics.packetLossPct != null ? `Packet loss: ${metrics.packetLossPct}%` : null,
      metrics.avgPingLatencyMs != null ? `Average ping latency: ${metrics.avgPingLatencyMs} ms` : null,
      metrics.dnsError ? `DNS error: ${metrics.dnsError}` : null,
      metrics.httpError ? `HTTP error: ${metrics.httpError}` : null,
      metrics.packetError ? `Packet probe error: ${metrics.packetError}` : null,
      `Measured at: ${metrics.measuredAt}`
    ]
      .filter(Boolean)
      .join('\n'),
    sourceUrl: config.sourceUrl || config.targetUrl || undefined,
    externalId: `${config.location}-${eventType}-${metrics.measuredAt}`,
    tags: Array.from(new Set([...tags, config.location.toLowerCase().replace(/\s+/g, '-')])).slice(0, 12),
    metadata: {
      location: config.location,
      dnsHost: config.dnsHost,
      targetHost: config.targetHost,
      targetUrl: config.targetUrl,
      dnsLatencyMs: metrics.dnsLatencyMs,
      httpLatencyMs: metrics.httpLatencyMs,
      packetLossPct: metrics.packetLossPct,
      avgPingLatencyMs: metrics.avgPingLatencyMs,
      packetCount: config.packetCount,
      severity: classification.severity,
      previousSeverity: previousSeverity || null,
      measuredAt: metrics.measuredAt
    }
  };
}

export async function runProbe(config) {
  const measuredAt = new Date().toISOString();
  const [dnsResult, httpResult, packetResult] = await Promise.allSettled([
    measureDnsLatency(config.dnsHost),
    measureHttpLatency(config.targetUrl),
    measurePacketLoss(config.targetHost, config.packetCount)
  ]);

  const metrics = {
    measuredAt,
    dnsLatencyMs: dnsResult.status === 'fulfilled' ? dnsResult.value : null,
    httpLatencyMs: httpResult.status === 'fulfilled' ? httpResult.value : null,
    packetLossPct: packetResult.status === 'fulfilled' ? packetResult.value.packetLossPct : 100,
    avgPingLatencyMs: packetResult.status === 'fulfilled' ? packetResult.value.avgLatencyMs : null,
    dnsError: dnsResult.status === 'rejected' ? String(dnsResult.reason?.message ?? dnsResult.reason ?? 'DNS probe failed') : null,
    httpError: httpResult.status === 'rejected' ? String(httpResult.reason?.message ?? httpResult.reason ?? 'HTTP probe failed') : null,
    packetError:
      packetResult.status === 'rejected' ? String(packetResult.reason?.message ?? packetResult.reason ?? 'Ping probe failed') : null
  };
  const classification = classifyConnectivity(metrics);
  return { metrics, classification };
}
