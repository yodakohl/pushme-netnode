#!/usr/bin/env node
import os from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { resolveNodeIdentity } from '../src/identity.mjs';
import { previewNetnodeCoverage } from '../src/pushme.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

function cleanInteger(value) {
  const numeric = Number(value ?? null);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : undefined;
}

function formatIdentity(identity) {
  return [
    identity.city,
    identity.region,
    identity.country || identity.countryCode,
    identity.provider,
    identity.asn ? `AS${identity.asn}` : null,
    identity.networkType
  ]
    .filter(Boolean)
    .join(' | ');
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const baseUrl = cleanText(args['base-url']) || config.pushmeBotUrl || 'https://pushme.site';
  const location = slugify(args.location || config.location || os.hostname()) || 'netnode';
  const baseIdentity = {
    ...config.nodeIdentity,
    countryCode: cleanText(args['country-code']) || config.nodeIdentity.countryCode,
    country: cleanText(args.country) || config.nodeIdentity.country,
    region: cleanText(args.region) || config.nodeIdentity.region,
    city: cleanText(args.city) || config.nodeIdentity.city,
    provider: cleanText(args.provider) || config.nodeIdentity.provider,
    providerDomain: cleanText(args['provider-domain']) || config.nodeIdentity.providerDomain,
    asn: cleanInteger(args.asn) ?? config.nodeIdentity.asn,
    networkType: cleanText(args['network-type']) || config.nodeIdentity.networkType,
    source: 'configured'
  };
  const identity = await resolveNodeIdentity(baseIdentity);
  const preview = await previewNetnodeCoverage(baseUrl, {
    location,
    countryCode: cleanText(identity.countryCode),
    country: cleanText(identity.country),
    region: cleanText(identity.region),
    city: cleanText(identity.city),
    provider: cleanText(identity.provider),
    asn: cleanInteger(identity.asn),
    networkType: cleanText(identity.networkType)
  });

  if (String(args.json || '').toLowerCase() === 'true') {
    console.log(JSON.stringify({ identity, preview }, null, 2));
    return;
  }

  console.log(`location: ${location}`);
  console.log(`identity: ${formatIdentity(identity) || 'unknown'}`);
  console.log(`value: ${preview.valueTier} (${preview.uniquenessScore}/100)`);
  console.log(`recommendation: ${preview.recommendation}`);
  console.log(`reasons: ${preview.reasons.join('; ')}`);
  if (Array.isArray(preview.currentCoverageGaps) && preview.currentCoverageGaps.length) {
    console.log('current network gaps:');
    for (const gap of preview.currentCoverageGaps.slice(0, 3)) {
      console.log(`- ${gap.title}: ${gap.detail}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
