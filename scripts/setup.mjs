#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolveNodeIdentity } from '../src/identity.mjs';
import { previewNetnodeCoverage, registerBotOrg } from '../src/pushme.mjs';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const EXAMPLE_ENV_PATH = path.resolve(process.cwd(), '.env.example');

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

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const entries = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) entries[key] = value;
  }
  return entries;
}

function writeEnvFile(filePath, values) {
  const lines = [
    `PUSHME_API_KEY=${values.PUSHME_API_KEY ?? ''}`,
    `PUSHME_BOT_URL=${values.PUSHME_BOT_URL ?? 'https://pushme.site'}`,
    `NETNODE_RELEASE_CHANNEL=${values.NETNODE_RELEASE_CHANNEL ?? 'stable'}`,
    `NETNODE_IMAGE_REPOSITORY=${values.NETNODE_IMAGE_REPOSITORY ?? 'ghcr.io/yodakohl/pushme-netnode'}`,
    `NETNODE_TARGET_HOST=${values.NETNODE_TARGET_HOST ?? '1.1.1.1'}`,
    `NETNODE_TARGET_URL=${values.NETNODE_TARGET_URL ?? 'https://1.1.1.1/cdn-cgi/trace'}`,
    `NETNODE_DNS_HOST=${values.NETNODE_DNS_HOST ?? 'example.com'}`,
    `NETNODE_PROFILES_JSON=${values.NETNODE_PROFILES_JSON ?? ''}`,
    `NETNODE_GROUP_THRESHOLDS_JSON=${values.NETNODE_GROUP_THRESHOLDS_JSON ?? ''}`,
    `NETNODE_LOCATION=${values.NETNODE_LOCATION ?? 'default-node'}`,
    `NETNODE_PACKET_COUNT=${values.NETNODE_PACKET_COUNT ?? '4'}`,
    `NETNODE_INTERVAL_MS=${values.NETNODE_INTERVAL_MS ?? '60000'}`,
    `NETNODE_STATE_FILE=${values.NETNODE_STATE_FILE ?? './netnode-state.json'}`,
    `NETNODE_PUBLISH_MODE=${values.NETNODE_PUBLISH_MODE ?? 'changes'}`,
    `NETNODE_SOURCE_URL=${values.NETNODE_SOURCE_URL ?? ''}`,
    `NETNODE_COUNTRY_CODE=${values.NETNODE_COUNTRY_CODE ?? ''}`,
    `NETNODE_COUNTRY=${values.NETNODE_COUNTRY ?? ''}`,
    `NETNODE_REGION=${values.NETNODE_REGION ?? ''}`,
    `NETNODE_CITY=${values.NETNODE_CITY ?? ''}`,
    `NETNODE_PROVIDER=${values.NETNODE_PROVIDER ?? ''}`,
    `NETNODE_PROVIDER_DOMAIN=${values.NETNODE_PROVIDER_DOMAIN ?? ''}`,
    `NETNODE_ASN=${values.NETNODE_ASN ?? ''}`,
    `NETNODE_NETWORK_TYPE=${values.NETNODE_NETWORK_TYPE ?? ''}`
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function buildDefaultProfiles() {
  return [
    {
      name: 'cloudflare-resolver',
      label: 'Cloudflare Resolver',
      group: 'resolver',
      targetHost: '1.1.1.1',
      targetUrl: 'https://1.1.1.1/cdn-cgi/trace',
      dnsHost: 'one.one.one.one'
    },
    {
      name: 'google-resolver',
      label: 'Google Resolver',
      group: 'resolver',
      targetHost: '8.8.8.8',
      targetUrl: 'https://www.google.com/generate_204',
      dnsHost: 'google.com'
    },
    {
      name: 'quad9-resolver',
      label: 'Quad9 Resolver',
      group: 'resolver',
      targetHost: '9.9.9.9',
      targetUrl: 'https://www.quad9.net/',
      dnsHost: 'dns.quad9.net'
    },
    {
      name: 'github-web',
      label: 'GitHub Web',
      group: 'web',
      targetHost: 'github.com',
      targetUrl: 'https://github.com/robots.txt',
      dnsHost: 'github.com'
    },
    {
      name: 'wikipedia-web',
      label: 'Wikipedia Web',
      group: 'web',
      targetHost: 'wikipedia.org',
      targetUrl: 'https://www.wikipedia.org/',
      dnsHost: 'wikipedia.org'
    },
    {
      name: 'example-web',
      label: 'Example Web',
      group: 'web',
      targetHost: 'example.com',
      targetUrl: 'https://example.com/',
      dnsHost: 'example.com'
    },
    {
      name: 'openai-status-ai',
      label: 'OpenAI Status',
      group: 'ai',
      targetHost: 'status.openai.com',
      targetUrl: 'https://status.openai.com/api/v2/status.json',
      dnsHost: 'status.openai.com',
      packetProbe: false,
      providerStatusEnabled: true,
      providerStatusAffectsSeverity: true
    },
    {
      name: 'anthropic-status-ai',
      label: 'Anthropic Status',
      group: 'ai',
      targetHost: 'status.anthropic.com',
      targetUrl: 'https://status.anthropic.com/api/v2/status.json',
      dnsHost: 'status.anthropic.com',
      packetProbe: false,
      providerStatusEnabled: true,
      providerStatusAffectsSeverity: true
    },
    {
      name: 'huggingface-ai',
      label: 'Hugging Face',
      group: 'ai',
      targetHost: 'huggingface.co',
      targetUrl: 'https://huggingface.co/',
      dnsHost: 'huggingface.co',
      packetProbe: false
    }
  ];
}

function buildDefaultGroupThresholds() {
  return {
    general: { dnsWarnMs: 250, httpWarnMs: 1200, httpDownMs: 4000, packetWarnPct: 5, packetDownPct: 60 },
    resolver: { dnsWarnMs: 250, httpWarnMs: 1500, httpDownMs: 4500, packetWarnPct: 5, packetDownPct: 60 },
    web: { dnsWarnMs: 400, httpWarnMs: 2600, httpDownMs: 5500, packetWarnPct: 5, packetDownPct: 60 },
    ai: { dnsWarnMs: 300, httpWarnMs: 3000, httpDownMs: 6000, packetWarnPct: 100, packetDownPct: 100 }
  };
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function promptValue(rl, label, fallback) {
  const suffix = fallback ? ` [${fallback}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || fallback;
}

async function resolveValue(rl, supplied, label, fallback) {
  if (String(supplied ?? '').trim()) return String(supplied).trim();
  if (!process.stdin.isTTY) return String(fallback ?? '').trim();
  return promptValue(rl, label, fallback);
}

function coalesce(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function cleanInteger(value) {
  const numeric = Number(value ?? null);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function buildBaseIdentity(values) {
  return {
    countryCode: values.NETNODE_COUNTRY_CODE ?? '',
    country: values.NETNODE_COUNTRY ?? '',
    region: values.NETNODE_REGION ?? '',
    city: values.NETNODE_CITY ?? '',
    provider: values.NETNODE_PROVIDER ?? '',
    providerDomain: values.NETNODE_PROVIDER_DOMAIN ?? '',
    asn: values.NETNODE_ASN ?? '',
    networkType: values.NETNODE_NETWORK_TYPE ?? '',
    source: 'configured'
  };
}

function formatIdentity(identity) {
  const parts = [
    identity.city,
    identity.region,
    identity.country || identity.countryCode,
    identity.provider,
    identity.asn ? `AS${identity.asn}` : null,
    identity.networkType
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : 'unknown';
}

function printCoveragePreview(preview) {
  output.write('\nCoverage preview\n');
  output.write(`  value: ${preview.valueTier} (${preview.uniquenessScore}/100)\n`);
  output.write(`  recommendation: ${preview.recommendation}\n`);
  output.write(`  reasons: ${preview.reasons.join('; ')}\n`);
  if (Array.isArray(preview.currentCoverageGaps) && preview.currentCoverageGaps.length) {
    output.write('  current network gaps:\n');
    for (const gap of preview.currentCoverageGaps.slice(0, 3)) {
      output.write(`    - ${gap.title}: ${gap.detail}\n`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const existing = {
    ...loadEnvFile(EXAMPLE_ENV_PATH),
    ...loadEnvFile(ENV_PATH)
  };
  const machine = slugify(os.hostname()) || 'netnode';
  const defaultLocation = existing.NETNODE_LOCATION && existing.NETNODE_LOCATION !== 'default-node'
    ? existing.NETNODE_LOCATION
    : machine;
  const defaultOrgName = existing.ORG_NAME || `Netnode ${machine}`;
  const defaultWebsiteUrl = existing.NETNODE_SOURCE_URL || 'https://pushme.site/internet-health-map';
  const baseUrl = existing.PUSHME_BOT_URL || 'https://pushme.site';
  const skipPreview = String(args['skip-preview'] || process.env.PUSHME_SETUP_SKIP_PREVIEW || '').trim().toLowerCase() === 'true';

  const rl = readline.createInterface({ input, output });
  try {
    output.write('PushMe netnode setup\n');
    output.write('This registers a publisher org and writes .env for this machine.\n\n');

    const orgName = await resolveValue(rl, args['org-name'] || process.env.PUSHME_SETUP_ORG_NAME, 'Publisher name', defaultOrgName);
    const location = slugify(await resolveValue(rl, args.location || process.env.PUSHME_SETUP_LOCATION, 'Node location slug', defaultLocation)) || machine;
    const websiteUrl = await resolveValue(rl, args['website-url'] || process.env.PUSHME_SETUP_WEBSITE_URL, 'Website URL', defaultWebsiteUrl);
    const email = await resolveValue(rl, args.email || process.env.PUSHME_SETUP_EMAIL, 'Optional contact email', existing.EMAIL || '');
    const targetHost = await resolveValue(rl, args['target-host'] || process.env.PUSHME_SETUP_TARGET_HOST, 'Legacy ping target host', existing.NETNODE_TARGET_HOST || '1.1.1.1');
    const targetUrl = await resolveValue(rl, args['target-url'] || process.env.PUSHME_SETUP_TARGET_URL, 'Legacy HTTP target URL', existing.NETNODE_TARGET_URL || 'https://1.1.1.1/cdn-cgi/trace');
    const dnsHost = await resolveValue(rl, args['dns-host'] || process.env.PUSHME_SETUP_DNS_HOST, 'Legacy DNS host', existing.NETNODE_DNS_HOST || 'example.com');
    const profilesJson = existing.NETNODE_PROFILES_JSON || JSON.stringify(buildDefaultProfiles());
    const groupThresholdsJson = existing.NETNODE_GROUP_THRESHOLDS_JSON || JSON.stringify(buildDefaultGroupThresholds());
    const baseIdentity = buildBaseIdentity(existing);

    output.write('\nDetecting node identity...\n');
    const detectedIdentity = await resolveNodeIdentity(baseIdentity);
    output.write(`detected identity: ${formatIdentity(detectedIdentity)}\n`);

    if (!skipPreview) {
      try {
        const preview = await previewNetnodeCoverage(baseUrl, {
          location,
          countryCode: coalesce(detectedIdentity.countryCode),
          country: coalesce(detectedIdentity.country),
          region: coalesce(detectedIdentity.region),
          city: coalesce(detectedIdentity.city),
          provider: coalesce(detectedIdentity.provider),
          asn: cleanInteger(detectedIdentity.asn),
          networkType: coalesce(detectedIdentity.networkType)
        });
        printCoveragePreview(preview);
      } catch (error) {
        output.write(`coverage preview skipped: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    } else {
      output.write('coverage preview skipped\n');
    }

    output.write('\nRegistering bot org with PushMe...\n');
    const registrationPayload = {
      orgName,
      role: 'publisher',
      websiteUrl,
      description: `Publishes internet connectivity events from ${location}.`
    };
    if (email) registrationPayload.email = email;
    const registration = await registerBotOrg(baseUrl, registrationPayload);

    writeEnvFile(ENV_PATH, {
      ...existing,
      PUSHME_API_KEY: registration.apiKey || '',
      PUSHME_BOT_URL: baseUrl,
      NETNODE_RELEASE_CHANNEL: existing.NETNODE_RELEASE_CHANNEL || 'stable',
      NETNODE_IMAGE_REPOSITORY: existing.NETNODE_IMAGE_REPOSITORY || 'ghcr.io/yodakohl/pushme-netnode',
      NETNODE_TARGET_HOST: targetHost,
      NETNODE_TARGET_URL: targetUrl,
      NETNODE_DNS_HOST: dnsHost,
      NETNODE_PROFILES_JSON: profilesJson,
      NETNODE_GROUP_THRESHOLDS_JSON: groupThresholdsJson,
      NETNODE_LOCATION: location,
      NETNODE_PACKET_COUNT: existing.NETNODE_PACKET_COUNT || '4',
      NETNODE_INTERVAL_MS: existing.NETNODE_INTERVAL_MS || '60000',
      NETNODE_STATE_FILE: existing.NETNODE_STATE_FILE || './netnode-state.json',
      NETNODE_PUBLISH_MODE: existing.NETNODE_PUBLISH_MODE || 'changes',
      NETNODE_SOURCE_URL: websiteUrl,
      NETNODE_COUNTRY_CODE: detectedIdentity.countryCode || existing.NETNODE_COUNTRY_CODE || '',
      NETNODE_COUNTRY: detectedIdentity.country || existing.NETNODE_COUNTRY || '',
      NETNODE_REGION: detectedIdentity.region || existing.NETNODE_REGION || '',
      NETNODE_CITY: detectedIdentity.city || existing.NETNODE_CITY || '',
      NETNODE_PROVIDER: detectedIdentity.provider || existing.NETNODE_PROVIDER || '',
      NETNODE_PROVIDER_DOMAIN: detectedIdentity.providerDomain || existing.NETNODE_PROVIDER_DOMAIN || '',
      NETNODE_ASN: detectedIdentity.asn || existing.NETNODE_ASN || '',
      NETNODE_NETWORK_TYPE: detectedIdentity.networkType || existing.NETNODE_NETWORK_TYPE || ''
    });

    output.write('\nSaved .env\n');
    output.write(`org: ${registration.org?.name || orgName}\n`);
    output.write(`location: ${location}\n`);
    output.write(`identity: ${formatIdentity(detectedIdentity)}\n`);
    output.write('default probe groups: resolver, web, ai\n');
    output.write('\nNext steps:\n');
    output.write('  npm run preview\n');
    output.write('  npm start -- --once --dry-run\n');
    output.write('  npm start\n');
  } finally {
    await rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
