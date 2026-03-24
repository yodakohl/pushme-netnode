import fs from 'node:fs';

export const NETNODE_STATE_SCHEMA_VERSION = 1;
export const DEFAULT_NETNODE_IMAGE_REPOSITORY = 'ghcr.io/yodakohl/pushme-netnode';
export const DEFAULT_NETNODE_RELEASE_CHANNEL = 'stable';

function readPackageVersion() {
  try {
    const url = new URL('../package.json', import.meta.url);
    const raw = fs.readFileSync(url, 'utf8');
    const parsed = JSON.parse(raw);
    return normalizeNodeVersion(parsed?.version) ?? '0.1.0';
  } catch {
    return '0.1.0';
  }
}

export const NETNODE_PACKAGE_VERSION = readPackageVersion();

export function normalizeNodeVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(text) ? text : null;
}

export function formatVersionTag(version) {
  const normalized = normalizeNodeVersion(version);
  return normalized ? `v${normalized}` : null;
}

export function normalizeReleaseChannel(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'stable' || text === 'edge') return text;
  const version = normalizeNodeVersion(text);
  return version ? `v${version}` : DEFAULT_NETNODE_RELEASE_CHANNEL;
}

export function buildImageReference(repository, releaseChannel) {
  const repo = String(repository || DEFAULT_NETNODE_IMAGE_REPOSITORY).trim() || DEFAULT_NETNODE_IMAGE_REPOSITORY;
  const channel = normalizeReleaseChannel(releaseChannel);
  return `${repo}:${channel}`;
}

export function buildUserAgent(version = NETNODE_PACKAGE_VERSION) {
  return `pushme-netnode/${normalizeNodeVersion(version) ?? NETNODE_PACKAGE_VERSION}`;
}
