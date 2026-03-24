import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState } from '../src/state.mjs';
import { NETNODE_STATE_SCHEMA_VERSION } from '../src/runtime.mjs';

test('loads legacy state files and marks them for migration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushme-netnode-state-'));
  const filePath = path.join(tmpDir, 'netnode-state.json');
  fs.writeFileSync(filePath, JSON.stringify({ lastSeverity: 'degraded', pendingCount: 2 }), 'utf8');

  const loaded = loadState(filePath);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.data.schemaVersion, NETNODE_STATE_SCHEMA_VERSION);
  assert.equal(loaded.data.lastSeverity, 'degraded');
  assert.equal(loaded.data.pendingCount, 2);
});

test('persists schemaVersion when saving state', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushme-netnode-state-'));
  const filePath = path.join(tmpDir, 'nested', 'netnode-state.json');
  saveState(filePath, { lastSeverity: 'ok' });

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(raw.schemaVersion, NETNODE_STATE_SCHEMA_VERSION);
  assert.equal(raw.lastSeverity, 'ok');
});
