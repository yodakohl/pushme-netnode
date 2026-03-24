import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePublication, shouldDebounceDegraded } from '../src/publishPolicy.mjs';

function makeProbeResult({
  severity = 'degraded',
  fingerprint = 'fp-1',
  impactedCount = 1,
  impactedGroups = ['resolver'],
  maxPacketLossPct = 0,
  profiles = [{ severity: 'degraded', dnsError: null, httpError: null, packetError: null, providerStatusSeverity: null }]
} = {}) {
  return {
    fingerprint,
    aggregate: { maxPacketLossPct },
    diagnosis: { impactedGroups },
    classification: {
      severity,
      impactedCount
    },
    profiles
  };
}

test('debounces localized latency-only degraded events', () => {
  const probe = makeProbeResult();
  assert.equal(shouldDebounceDegraded(probe), true);
});

test('does not debounce broad packet-loss degradation', () => {
  const probe = makeProbeResult({
    impactedCount: 6,
    impactedGroups: ['resolver', 'web', 'ai'],
    maxPacketLossPct: 100
  });
  assert.equal(shouldDebounceDegraded(probe), false);
});

test('waits for confirmation before publishing minor degraded event', () => {
  const decision = decidePublication({}, makeProbeResult());
  assert.equal(decision.publish, false);
  assert.equal(decision.reason, 'waiting for degraded confirmation');
  assert.equal(decision.nextState.pendingCount, 1);
});

test('publishes minor degraded event after repeated identical probe', () => {
  const state = {
    pendingFingerprint: 'fp-1',
    pendingCount: 1
  };
  const decision = decidePublication(state, makeProbeResult());
  assert.equal(decision.publish, true);
  assert.match(decision.reason, /persisted/);
  assert.equal(decision.nextState.pendingFingerprint, null);
});

test('publishes significant degraded event immediately', () => {
  const decision = decidePublication(
    {},
    makeProbeResult({
      impactedCount: 6,
      impactedGroups: ['resolver', 'web', 'ai'],
      maxPacketLossPct: 100
    })
  );
  assert.equal(decision.publish, true);
  assert.equal(decision.reason, 'significant degradation');
});

test('does not publish healthy state when no incident was published', () => {
  const decision = decidePublication(
    { pendingFingerprint: 'fp-1', pendingCount: 1, pendingSeverity: 'degraded' },
    makeProbeResult({ severity: 'ok', fingerprint: 'fp-ok', impactedCount: 0, impactedGroups: [], profiles: [{ severity: 'ok' }] })
  );
  assert.equal(decision.publish, false);
  assert.equal(decision.reason, 'healthy with no published incident');
});

test('publishes recovery only after a published degraded state', () => {
  const decision = decidePublication(
    { lastSeverity: 'degraded', lastFingerprint: 'fp-1' },
    makeProbeResult({ severity: 'ok', fingerprint: 'fp-ok', impactedCount: 0, impactedGroups: [], profiles: [{ severity: 'ok' }] })
  );
  assert.equal(decision.publish, true);
  assert.equal(decision.reason, 'published recovery');
});
