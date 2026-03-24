import { buildUserAgent } from './runtime.mjs';

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeProviderLabel(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^[A-Z0-9 .,&-]+$/.test(text)) {
    return text
      .toLowerCase()
      .split(/([\s,&-]+)/)
      .map((part) => (/^[\s,&-]+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('');
  }
  return text;
}

function cleanCountryCode(value) {
  const text = cleanText(value);
  return text ? text.toUpperCase() : null;
}

function cleanAsn(value) {
  const numeric = Number(value ?? null);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

const cloudProviderHints = [
  'amazon',
  'aws',
  'google',
  'digitalocean',
  'hetzner',
  'oracle',
  'azure',
  'microsoft',
  'linode',
  'akamai',
  'ovh',
  'vultr',
  'contabo',
  'scaleway',
  'alibaba',
  'tencent',
  'ibm cloud',
  'choopa'
];

export function inferNetworkType(identity = {}) {
  const explicit = cleanText(identity.networkType);
  if (explicit) return explicit.toLowerCase();
  const providerText = `${cleanText(identity.provider) || ''} ${cleanText(identity.providerDomain) || ''}`.toLowerCase();
  if (cloudProviderHints.some((hint) => providerText.includes(hint))) return 'cloud';
  return 'unknown';
}

export function normalizeNodeIdentity(raw = {}) {
  const identity = {
    countryCode: cleanCountryCode(raw.countryCode ?? raw.country_code),
    country: cleanText(raw.country),
    region: cleanText(raw.region),
    city: cleanText(raw.city),
    provider: normalizeProviderLabel(raw.provider ?? raw.org ?? raw.isp),
    providerDomain: cleanText(raw.providerDomain ?? raw.domain),
    asn: cleanAsn(raw.asn),
    networkType: cleanText(raw.networkType),
    source: cleanText(raw.source) ?? 'configured'
  };
  identity.networkType = inferNetworkType(identity);
  return identity;
}

export function mergeNodeIdentity(configured = {}, detected = {}) {
  const left = normalizeNodeIdentity(configured);
  const right = normalizeNodeIdentity(detected);
  const configuredNetworkType = cleanText(configured.networkType);
  const merged = {
    countryCode: left.countryCode ?? right.countryCode,
    country: left.country ?? right.country,
    region: left.region ?? right.region,
    city: left.city ?? right.city,
    provider: left.provider ?? right.provider,
    providerDomain: left.providerDomain ?? right.providerDomain,
    asn: left.asn ?? right.asn,
    networkType: configuredNetworkType && configuredNetworkType.toLowerCase() !== 'unknown' ? left.networkType : right.networkType,
    source: left.source === 'configured' && right.source && right.source !== 'configured' ? `${left.source}+${right.source}` : left.source
  };
  merged.networkType = inferNetworkType(merged);
  return merged;
}

export function shouldLookupNodeIdentity(identity = {}) {
  const normalized = normalizeNodeIdentity(identity);
  return !(normalized.countryCode && normalized.provider && normalized.asn && normalized.networkType && normalized.networkType !== 'unknown');
}

export async function fetchDetectedNodeIdentity() {
  const endpoints = [
    {
      url: 'https://ifconfig.co/json',
      map: (payload) => ({
        countryCode: payload.country_iso,
        country: payload.country,
        region: payload.region_name,
        city: payload.city,
        provider: normalizeProviderLabel(payload.org ?? String(payload.asn_org ?? '').replace(/-ASN$/i, '')),
        asn: String(payload.asn ?? '').replace(/^AS/i, ''),
        source: 'ifconfig.co'
      })
    },
    {
      url: 'https://ipinfo.io/json',
      map: (payload) => {
        const orgText = cleanText(payload.org);
        const asnMatch = orgText?.match(/^AS(\d+)\s+(.+)$/i);
        return {
          countryCode: payload.country,
          country: payload.country,
          region: payload.region,
          city: payload.city,
          provider: asnMatch ? asnMatch[2] : orgText,
          asn: asnMatch ? asnMatch[1] : null,
          source: 'ipinfo.io'
        };
      }
    }
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        headers: {
          'user-agent': buildUserAgent()
        }
      });
      if (!response.ok) {
        lastError = new Error(`Node identity lookup failed with ${response.status} via ${endpoint.url}`);
        continue;
      }
      const payload = await response.json();
      return normalizeNodeIdentity(endpoint.map(payload));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Node identity lookup failed');
}

export async function resolveNodeIdentity(baseIdentity = {}) {
  const configured = normalizeNodeIdentity(baseIdentity);
  if (!shouldLookupNodeIdentity(configured)) {
    return configured;
  }
  try {
    const detected = await fetchDetectedNodeIdentity();
    return mergeNodeIdentity(configured, detected);
  } catch {
    return configured;
  }
}
