import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectivity, buildEventPayload } from '../src/netnode.mjs';

test('classifies healthy connectivity as ok', () => {
  const result = classifyConnectivity({
    dnsLatencyMs: 40,
    httpLatencyMs: 120,
    packetLossPct: 0,
    dnsError: null,
    httpError: null,
    packetError: null
  });
  assert.equal(result.severity, 'ok');
  assert.equal(result.eventType, 'net.connectivity.ok');
});

test('classifies packet loss as degraded', () => {
  const result = classifyConnectivity({
    dnsLatencyMs: 60,
    httpLatencyMs: 180,
    packetLossPct: 12,
    dnsError: null,
    httpError: null,
    packetError: null
  });
  assert.equal(result.severity, 'degraded');
  assert.equal(result.eventType, 'net.connectivity.degraded');
});

test('classifies major failures as down', () => {
  const result = classifyConnectivity({
    dnsLatencyMs: null,
    httpLatencyMs: null,
    packetLossPct: 100,
    dnsError: 'lookup failed',
    httpError: 'timeout',
    packetError: 'unreachable'
  });
  assert.equal(result.severity, 'down');
  assert.equal(result.eventType, 'net.connectivity.down');
});

test('builds recovered event when previous severity was non-ok', () => {
  const payload = buildEventPayload(
    {
      location: 'home-office',
      dnsHost: 'example.com',
      targetHost: '1.1.1.1',
      targetUrl: 'https://1.1.1.1/cdn-cgi/trace',
      packetCount: 4,
      sourceUrl: ''
    },
    {
      measuredAt: '2026-03-07T00:00:00.000Z',
      dnsLatencyMs: 20,
      httpLatencyMs: 90,
      packetLossPct: 0,
      avgPingLatencyMs: 12,
      dnsError: null,
      httpError: null,
      packetError: null
    },
    {
      severity: 'ok',
      eventType: 'net.connectivity.ok',
      tags: ['network', 'healthy']
    },
    'degraded'
  );
  assert.equal(payload.eventType, 'net.connectivity.recovered');
  assert.match(payload.title, /recovered/i);
  assert.equal(payload.metadata.previousSeverity, 'degraded');
});
