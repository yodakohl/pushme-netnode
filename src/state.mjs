import fs from 'node:fs';
import path from 'node:path';

export function loadState(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return { path: resolved, data: { lastSeverity: null, lastPublishedAt: null } };
  }
  try {
    const data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return { path: resolved, data: data && typeof data === 'object' ? data : { lastSeverity: null, lastPublishedAt: null } };
  } catch {
    return { path: resolved, data: { lastSeverity: null, lastPublishedAt: null } };
  }
}

export function saveState(filePath, data) {
  const resolved = path.resolve(process.cwd(), filePath);
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2));
}

