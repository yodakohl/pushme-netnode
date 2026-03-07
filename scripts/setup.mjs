#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

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
    `NETNODE_TARGET_HOST=${values.NETNODE_TARGET_HOST ?? '1.1.1.1'}`,
    `NETNODE_TARGET_URL=${values.NETNODE_TARGET_URL ?? 'https://1.1.1.1/cdn-cgi/trace'}`,
    `NETNODE_DNS_HOST=${values.NETNODE_DNS_HOST ?? 'example.com'}`,
    `NETNODE_LOCATION=${values.NETNODE_LOCATION ?? 'default-node'}`,
    `NETNODE_PACKET_COUNT=${values.NETNODE_PACKET_COUNT ?? '4'}`,
    `NETNODE_INTERVAL_MS=${values.NETNODE_INTERVAL_MS ?? '60000'}`,
    `NETNODE_STATE_FILE=${values.NETNODE_STATE_FILE ?? './netnode-state.json'}`,
    `NETNODE_PUBLISH_MODE=${values.NETNODE_PUBLISH_MODE ?? 'changes'}`,
    `NETNODE_SOURCE_URL=${values.NETNODE_SOURCE_URL ?? ''}`
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
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

async function registerOrg(baseUrl, payload) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/bot/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Registration failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
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

  const rl = readline.createInterface({ input, output });
  try {
    output.write('PushMe netnode setup\n');
    output.write('This registers a publisher org and writes .env for this machine.\n\n');

    const email = await resolveValue(rl, args.email || process.env.PUSHME_SETUP_EMAIL, 'Publisher email', existing.EMAIL || '');
    if (!email) {
      throw new Error('Email is required.');
    }
    const orgName = await resolveValue(rl, args['org-name'] || process.env.PUSHME_SETUP_ORG_NAME, 'Publisher name', defaultOrgName);
    const location = slugify(await resolveValue(rl, args.location || process.env.PUSHME_SETUP_LOCATION, 'Node location slug', defaultLocation)) || machine;
    const websiteUrl = await resolveValue(rl, args['website-url'] || process.env.PUSHME_SETUP_WEBSITE_URL, 'Website URL', defaultWebsiteUrl);
    const targetHost = await resolveValue(rl, args['target-host'] || process.env.PUSHME_SETUP_TARGET_HOST, 'Ping target host', existing.NETNODE_TARGET_HOST || '1.1.1.1');
    const targetUrl = await resolveValue(rl, args['target-url'] || process.env.PUSHME_SETUP_TARGET_URL, 'HTTP target URL', existing.NETNODE_TARGET_URL || 'https://1.1.1.1/cdn-cgi/trace');
    const dnsHost = await resolveValue(rl, args['dns-host'] || process.env.PUSHME_SETUP_DNS_HOST, 'DNS host', existing.NETNODE_DNS_HOST || 'example.com');

    output.write('\nRegistering bot org with PushMe...\n');
    const registration = await registerOrg(baseUrl, {
      orgName,
      email,
      role: 'publisher',
      websiteUrl,
      description: `Publishes internet connectivity events from ${location}.`
    });

    writeEnvFile(ENV_PATH, {
      ...existing,
      PUSHME_API_KEY: registration.apiKey || '',
      PUSHME_BOT_URL: baseUrl,
      NETNODE_TARGET_HOST: targetHost,
      NETNODE_TARGET_URL: targetUrl,
      NETNODE_DNS_HOST: dnsHost,
      NETNODE_LOCATION: location,
      NETNODE_PACKET_COUNT: existing.NETNODE_PACKET_COUNT || '4',
      NETNODE_INTERVAL_MS: existing.NETNODE_INTERVAL_MS || '60000',
      NETNODE_STATE_FILE: existing.NETNODE_STATE_FILE || './netnode-state.json',
      NETNODE_PUBLISH_MODE: existing.NETNODE_PUBLISH_MODE || 'changes',
      NETNODE_SOURCE_URL: websiteUrl
    });

    output.write('\nSaved .env\n');
    output.write(`org: ${registration.org?.name || orgName}\n`);
    output.write(`location: ${location}\n`);
    output.write('\nNext steps:\n');
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
