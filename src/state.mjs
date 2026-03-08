import fs from 'node:fs';
import path from 'node:path';

export function loadState(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return { path: resolved, data: { lastSeverity: null, lastFingerprint: null, lastPublishedAt: null } };
  }
  try {
    const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const base = data && typeof data === 'object' ? data : {};
    return {
      path: resolved,
      data: {
        lastSeverity: base.lastSeverity ?? null,
        lastFingerprint: base.lastFingerprint ?? null,
        lastPublishedAt: base.lastPublishedAt ?? null
      }
    };
  } catch {
    return { path: resolved, data: { lastSeverity: null, lastFingerprint: null, lastPublishedAt: null } };
  }
}

export function saveState(filePath, data) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2));
}
