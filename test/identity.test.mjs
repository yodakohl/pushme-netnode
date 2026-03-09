import test from 'node:test';
import assert from 'node:assert/strict';
import { inferNetworkType, mergeNodeIdentity, normalizeNodeIdentity } from '../src/identity.mjs';

test('infers cloud network type from known providers', () => {
  assert.equal(inferNetworkType({ provider: 'DigitalOcean, LLC' }), 'cloud');
  assert.equal(inferNetworkType({ provider: 'Unknown ISP' }), 'unknown');
});

test('normalizes and merges configured and detected node identity', () => {
  const merged = mergeNodeIdentity(
    { countryCode: 'de', networkType: 'mobile', source: 'configured' },
    { country: 'Germany', region: 'Hesse', provider: 'Airtel', asn: 9498, source: 'ipwho.is' }
  );

  assert.deepEqual(normalizeNodeIdentity(merged), {
    countryCode: 'DE',
    country: 'Germany',
    region: 'Hesse',
    city: null,
    provider: 'Airtel',
    providerDomain: null,
    asn: 9498,
    networkType: 'mobile',
    source: 'configured+ipwho.is'
  });
});
