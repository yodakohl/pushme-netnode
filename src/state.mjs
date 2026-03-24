import fs from 'node:fs';
import path from 'node:path';
import { NETNODE_STATE_SCHEMA_VERSION } from './runtime.mjs';

function createDefaultState() {
  return {
    schemaVersion: NETNODE_STATE_SCHEMA_VERSION,
    lastSeverity: null,
    lastFingerprint: null,
    lastPublishedAt: null,
    pendingFingerprint: null,
    pendingCount: 0,
    pendingSeverity: null
  };
}

function normalizeState(raw = {}) {
  const base = raw && typeof raw === 'object' ? raw : {};
  return {
    schemaVersion: NETNODE_STATE_SCHEMA_VERSION,
    lastSeverity: base.lastSeverity ?? null,
    lastFingerprint: base.lastFingerprint ?? null,
    lastPublishedAt: base.lastPublishedAt ?? null,
    pendingFingerprint: base.pendingFingerprint ?? null,
    pendingCount: Number(base.pendingCount ?? 0) || 0,
    pendingSeverity: base.pendingSeverity ?? null
  };
}

export function loadState(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return {
      path: resolved,
      migrated: false,
      data: createDefaultState()
    };
  }
  try {
    const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const base = data && typeof data === 'object' ? data : {};
    const schemaVersion = Number(base.schemaVersion ?? 0) || 0;
    return {
      path: resolved,
      migrated: schemaVersion !== NETNODE_STATE_SCHEMA_VERSION,
      data: normalizeState(base)
    };
  } catch {
    return {
      path: resolved,
      migrated: false,
      data: createDefaultState()
    };
  }
}

export function saveState(filePath, data) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(normalizeState(data), null, 2));
}
