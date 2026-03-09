import test from 'node:test';
import assert from 'node:assert/strict';
import { previewNetnodeCoverage, publishEvent, registerBotOrg } from '../src/pushme.mjs';

test('registers bot org against the expected endpoint', async () => {
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      text: async () => JSON.stringify({ apiKey: 'test-key', org: { id: 1, name: 'Test Bot' } })
    };
  };
  try {
    const response = await registerBotOrg('https://pushme.site/', { orgName: 'Test Bot', role: 'publisher' });
    assert.equal(response.apiKey, 'test-key');
    assert.equal(calls[0].url, 'https://pushme.site/api/bot/register');
  } finally {
    global.fetch = previousFetch;
  }
});

test('requests a netnode coverage preview against the expected endpoint', async () => {
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      text: async () => JSON.stringify({ valueTier: 'high', uniquenessScore: 100 })
    };
  };
  try {
    const response = await previewNetnodeCoverage('https://pushme.site/', { location: 'fra-home' });
    assert.equal(response.valueTier, 'high');
    assert.equal(calls[0].url, 'https://pushme.site/api/bot/netnode/coverage-preview');
  } finally {
    global.fetch = previousFetch;
  }
});

test('publishes events against the expected endpoint', async () => {
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, id: 123 })
    };
  };
  try {
    const response = await publishEvent('https://pushme.site/', 'token-1', { eventType: 'net.connectivity.ok' });
    assert.equal(response.id, 123);
    assert.equal(calls[0].url, 'https://pushme.site/api/bot/publish');
    assert.equal(calls[0].options.headers.authorization, 'Bearer token-1');
  } finally {
    global.fetch = previousFetch;
  }
});
