import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectivity, deriveDiagnosis, buildEventPayload, createStatusFingerprint } from '../src/netnode.mjs';

function makeProfiles(entries) {
  return entries.map((entry) => ({
    group: 'general',
    dnsError: null,
    httpError: null,
    packetError: null,
    ...entry
  }));
}

test('classifies all-healthy multi-target connectivity as ok', () => {
  const result = classifyConnectivity(
    makeProfiles([
      { name: 'cloudflare', severity: 'ok' },
      { name: 'google', severity: 'ok' },
      { name: 'quad9', severity: 'ok' }
    ])
  );
  assert.equal(result.severity, 'ok');
  assert.equal(result.eventType, 'net.connectivity.ok');
  assert.equal(result.scope, 'healthy');
});

test('classifies one impacted target as degraded and localized', () => {
  const result = classifyConnectivity(
    makeProfiles([
      { name: 'cloudflare', severity: 'degraded' },
      { name: 'google', severity: 'ok' },
      { name: 'quad9', severity: 'ok' }
    ])
  );
  assert.equal(result.severity, 'degraded');
  assert.equal(result.eventType, 'net.connectivity.degraded');
  assert.equal(result.scope, 'localized');
});

test('classifies majority target failures as down', () => {
  const result = classifyConnectivity(
    makeProfiles([
      { name: 'cloudflare', severity: 'down' },
      { name: 'google', severity: 'down' },
      { name: 'quad9', severity: 'ok' }
    ])
  );
  assert.equal(result.severity, 'down');
  assert.equal(result.eventType, 'net.connectivity.down');
  assert.equal(result.scope, 'partial');
});

test('derives resolver diagnosis when only resolver profiles are impacted', () => {
  const profiles = makeProfiles([
    { name: 'cloudflare-resolver', group: 'resolver', severity: 'degraded' },
    { name: 'google-resolver', group: 'resolver', severity: 'degraded' },
    { name: 'github-web', group: 'web', severity: 'ok' },
    { name: 'wikipedia-web', group: 'web', severity: 'ok' }
  ]);
  const classification = classifyConnectivity(profiles);
  const diagnosis = deriveDiagnosis(
    profiles,
    [
      { group: 'resolver', profileCount: 2, impactedCount: 2 },
      { group: 'web', profileCount: 2, impactedCount: 0 }
    ],
    classification
  );
  assert.equal(diagnosis.code, 'resolver-reachability-issue');
});


test('derives AI platform diagnosis when only ai profiles are impacted', () => {
  const profiles = makeProfiles([
    { name: 'openai-status-ai', group: 'ai', severity: 'degraded' },
    { name: 'anthropic-status-ai', group: 'ai', severity: 'degraded' },
    { name: 'github-web', group: 'web', severity: 'ok' },
    { name: 'cloudflare-resolver', group: 'resolver', severity: 'ok' }
  ]);
  const classification = classifyConnectivity(profiles);
  const diagnosis = deriveDiagnosis(
    profiles,
    [
      { group: 'ai', profileCount: 2, impactedCount: 2 },
      { group: 'resolver', profileCount: 1, impactedCount: 0 },
      { group: 'web', profileCount: 1, impactedCount: 0 }
    ],
    classification
  );
  assert.equal(diagnosis.code, 'ai-platform-access-issue');
});

test('builds recovered event when previous severity was non-ok', () => {
  const payload = buildEventPayload(
    {
      location: 'home-office',
      packetCount: 4,
      sourceUrl: ''
    },
    {
      measuredAt: '2026-03-07T00:00:00.000Z',
      profiles: [
        {
          name: 'cloudflare-resolver',
          label: 'Cloudflare Resolver',
          group: 'resolver',
          targetHost: '1.1.1.1',
          targetUrl: 'https://1.1.1.1/cdn-cgi/trace',
          dnsHost: 'one.one.one.one',
          severity: 'ok',
          dnsLatencyMs: 20,
          httpLatencyMs: 90,
          packetLossPct: 0,
          avgPingLatencyMs: 12,
          dnsError: null,
          httpError: null,
          packetError: null
        },
        {
          name: 'github-web',
          label: 'GitHub Web',
          group: 'web',
          targetHost: 'github.com',
          targetUrl: 'https://github.com/robots.txt',
          dnsHost: 'github.com',
          severity: 'ok',
          dnsLatencyMs: 18,
          httpLatencyMs: 100,
          packetLossPct: 0,
          avgPingLatencyMs: 10,
          dnsError: null,
          httpError: null,
          packetError: null
        }
      ],
      aggregate: {
        avgDnsLatencyMs: 19,
        avgHttpLatencyMs: 95,
        avgPingLatencyMs: 11,
        maxPacketLossPct: 0
      },
      groupStats: [
        { group: 'resolver', profileCount: 1, impactedCount: 0, downCount: 0, degradedCount: 0, avgDnsLatencyMs: 20, avgHttpLatencyMs: 90, avgPingLatencyMs: 12, maxPacketLossPct: 0, impactedProfiles: [] },
        { group: 'web', profileCount: 1, impactedCount: 0, downCount: 0, degradedCount: 0, avgDnsLatencyMs: 18, avgHttpLatencyMs: 100, avgPingLatencyMs: 10, maxPacketLossPct: 0, impactedProfiles: [] }
      ],
      diagnosis: {
        code: 'healthy',
        label: 'healthy connectivity',
        summary: 'All configured probe groups are healthy.',
        impactedGroups: []
      },
      classification: {
        severity: 'ok',
        eventType: 'net.connectivity.ok',
        tags: ['network', 'healthy'],
        scope: 'healthy',
        profileCount: 2,
        impactedCount: 0
      }
    },
    { lastSeverity: 'degraded' }
  );
  assert.equal(payload.eventType, 'net.connectivity.recovered');
  assert.match(payload.title, /recovered/i);
  assert.equal(payload.metadata.previousSeverity, 'degraded');
  assert.equal(payload.metadata.profileCount, 2);
  assert.equal(payload.metadata.profile_cloudflare_resolver_severity, 'ok');
  assert.equal(payload.metadata.diagnosisCode, 'healthy');
  assert.equal(typeof payload.metadata.groupStatsJson, 'string');
  assert.equal(typeof payload.metadata.profilesJson, 'string');
});

test('status fingerprint changes when diagnosis changes', () => {
  const baseProfiles = makeProfiles([
    { name: 'cloudflare-resolver', group: 'resolver', severity: 'degraded' },
    { name: 'github-web', group: 'web', severity: 'ok' }
  ]);
  const fingerprintA = createStatusFingerprint(baseProfiles, { severity: 'degraded', scope: 'localized', impactedCount: 1, profileCount: 2 }, { code: 'resolver-reachability-issue' });
  const fingerprintB = createStatusFingerprint(baseProfiles, { severity: 'degraded', scope: 'localized', impactedCount: 1, profileCount: 2 }, { code: 'single-destination-anomaly' });
  assert.notEqual(fingerprintA, fingerprintB);
});
