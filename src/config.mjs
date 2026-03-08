import fs from 'node:fs';
import path from 'node:path';

const defaultProfiles = [
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
    packetProbe: false
  },
  {
    name: 'anthropic-status-ai',
    label: 'Anthropic Status',
    group: 'ai',
    targetHost: 'status.anthropic.com',
    targetUrl: 'https://status.anthropic.com/api/v2/status.json',
    dnsHost: 'status.anthropic.com',
    packetProbe: false
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

function slugify(value, fallback = 'probe') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}

function normalizeProfiles(rawProfiles, legacyProfile) {
  const source = Array.isArray(rawProfiles) && rawProfiles.length ? rawProfiles : [legacyProfile];
  return source
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const targetHost = String(item.targetHost ?? '').trim();
      const targetUrl = String(item.targetUrl ?? '').trim();
      const dnsHost = String(item.dnsHost ?? '').trim();
      if (!targetHost || !targetUrl || !dnsHost) return null;
      return {
        name: slugify(item.name ?? `probe-${index + 1}`, `probe-${index + 1}`),
        label: String(item.label ?? item.name ?? targetHost).trim() || targetHost,
        group: slugify(item.group ?? 'general', 'general'),
        targetHost,
        targetUrl,
        dnsHost,
        packetProbe: item.packetProbe !== false
      };
    })
    .filter(Boolean);
}

function readProfiles(legacyProfile) {
  const rawJson = readText('NETNODE_PROFILES_JSON', '');
  if (!rawJson) {
    return normalizeProfiles(defaultProfiles, legacyProfile);
  }
  try {
    const parsed = JSON.parse(rawJson);
    const profiles = normalizeProfiles(parsed, legacyProfile);
    return profiles.length ? profiles : normalizeProfiles(defaultProfiles, legacyProfile);
  } catch {
    return normalizeProfiles(defaultProfiles, legacyProfile);
  }
}

loadDotEnv();

export function loadConfig() {
  const legacyProfile = {
    name: 'primary',
    group: 'general',
    targetHost: readText('NETNODE_TARGET_HOST', '1.1.1.1'),
    targetUrl: readText('NETNODE_TARGET_URL', 'https://1.1.1.1/cdn-cgi/trace'),
    dnsHost: readText('NETNODE_DNS_HOST', 'example.com'),
    packetProbe: true
  };
  const profiles = readProfiles(legacyProfile);
  return {
    pushmeApiKey: readText('PUSHME_API_KEY'),
    pushmeBotUrl: readText('PUSHME_BOT_URL', 'https://pushme.site'),
    targetHost: profiles[0]?.targetHost ?? legacyProfile.targetHost,
    targetUrl: profiles[0]?.targetUrl ?? legacyProfile.targetUrl,
    dnsHost: profiles[0]?.dnsHost ?? legacyProfile.dnsHost,
    profiles,
    location: readText('NETNODE_LOCATION', 'default-node'),
    packetCount: Math.max(1, Math.min(10, Math.trunc(readNumber('NETNODE_PACKET_COUNT', 4)))),
    intervalMs: Math.max(5000, Math.trunc(readNumber('NETNODE_INTERVAL_MS', 60000))),
    stateFile: readText('NETNODE_STATE_FILE', './netnode-state.json'),
    publishMode: readText('NETNODE_PUBLISH_MODE', 'changes').toLowerCase(),
    sourceUrl: readText('NETNODE_SOURCE_URL', '')
  };
}
