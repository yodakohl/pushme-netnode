import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectivity, buildEventPayload, createStatusFingerprint } from '../src/netnode.mjs';

test('classifies all-healthy multi-target connectivity as ok', () => {
  const result = classifyConnectivity([
    { name: 'cloudflare', severity: 'ok' },
    { name: 'google', severity: 'ok' },
    { name: 'quad9', severity: 'ok' }
  ]);
  assert.equal(result.severity, 'ok');
  assert.equal(result.eventType, 'net.connectivity.ok');
  assert.equal(result.scope, 'healthy');
});

test('classifies one impacted target as degraded and localized', () => {
  const result = classifyConnectivity([
    { name: 'cloudflare', severity: 'degraded' },
    { name: 'google', severity: 'ok' },
    { name: 'quad9', severity: 'ok' }
  ]);
  assert.equal(result.severity, 'degraded');
  assert.equal(result.eventType, 'net.connectivity.degraded');
  assert.equal(result.scope, 'localized');
});

test('classifies majority target failures as down', () => {
  const result = classifyConnectivity([
    { name: 'cloudflare', severity: 'down' },
    { name: 'google', severity: 'down' },
    { name: 'quad9', severity: 'ok' }
  ]);
  assert.equal(result.severity, 'down');
  assert.equal(result.eventType, 'net.connectivity.down');
  assert.equal(result.scope, 'partial');
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
          name: 'cloudflare',
          label: 'Cloudflare',
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
          name: 'google',
          label: 'Google',
          targetHost: '8.8.8.8',
          targetUrl: 'https://www.google.com/generate_204',
          dnsHost: 'google.com',
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
  assert.equal(payload.metadata.profile_cloudflare_severity, 'ok');
  assert.equal(payload.metadata.impactedProfilesCsv, '');
  assert.equal(typeof payload.metadata.profilesJson, 'string');
});

test('status fingerprint changes when impacted target changes', () => {
  const fingerprintA = createStatusFingerprint(
    [
      { name: 'cloudflare', severity: 'degraded', dnsError: null, httpError: null, packetError: null },
      { name: 'google', severity: 'ok', dnsError: null, httpError: null, packetError: null }
    ],
    { severity: 'degraded', scope: 'localized', impactedCount: 1, profileCount: 2 }
  );
  const fingerprintB = createStatusFingerprint(
    [
      { name: 'cloudflare', severity: 'ok', dnsError: null, httpError: null, packetError: null },
      { name: 'google', severity: 'degraded', dnsError: null, httpError: null, packetError: null }
    ],
    { severity: 'degraded', scope: 'localized', impactedCount: 1, profileCount: 2 }
  );
  assert.notEqual(fingerprintA, fingerprintB);
});
