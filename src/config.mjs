import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!key || process.env[key] != null) continue;
    process.env[key] = value;
  }
}

function readNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function readText(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

loadDotEnv();

export function loadConfig() {
  return {
    pushmeApiKey: readText('PUSHME_API_KEY'),
    pushmeBotUrl: readText('PUSHME_BOT_URL', 'https://pushme.site'),
    targetHost: readText('NETNODE_TARGET_HOST', '1.1.1.1'),
    targetUrl: readText('NETNODE_TARGET_URL', 'https://1.1.1.1/cdn-cgi/trace'),
    dnsHost: readText('NETNODE_DNS_HOST', 'example.com'),
    location: readText('NETNODE_LOCATION', 'default-node'),
    packetCount: Math.max(1, Math.min(10, Math.trunc(readNumber('NETNODE_PACKET_COUNT', 4)))),
    intervalMs: Math.max(5000, Math.trunc(readNumber('NETNODE_INTERVAL_MS', 60000))),
    stateFile: readText('NETNODE_STATE_FILE', './netnode-state.json'),
    publishMode: readText('NETNODE_PUBLISH_MODE', 'changes').toLowerCase(),
    sourceUrl: readText('NETNODE_SOURCE_URL', '')
  };
}

