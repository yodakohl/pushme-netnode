#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { resolveNodeIdentity } from './identity.mjs';
import { runProbe, buildEventPayload } from './netnode.mjs';
import { publishEvent } from './pushme.mjs';
import { loadState, saveState } from './state.mjs';

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    once: args.has('--once'),
    dryRun: args.has('--dry-run')
  };
}

function shouldPublish(mode, previousFingerprint, nextFingerprint) {
  if (mode === 'always') return true;
  return previousFingerprint !== nextFingerprint;
}

async function executeProbe(config, args) {
  const state = loadState(config.stateFile);
  const previousSeverity = state.data.lastSeverity ?? null;
  const previousFingerprint = state.data.lastFingerprint ?? null;
  const probeResult = await runProbe(config);
  const payload = buildEventPayload(config, probeResult, state.data);

  const output = {
    severity: probeResult.classification.severity,
    previousSeverity,
    previousFingerprint,
    fingerprint: probeResult.fingerprint,
    profiles: probeResult.profiles,
    aggregate: probeResult.aggregate,
    payload
  };

  if (!shouldPublish(config.publishMode, previousFingerprint, probeResult.fingerprint)) {
    console.log(JSON.stringify({ ...output, skipped: true, reason: 'no state change' }, null, 2));
    saveState(config.stateFile, {
      lastSeverity: probeResult.classification.severity,
      lastFingerprint: probeResult.fingerprint,
      lastPublishedAt: state.data.lastPublishedAt ?? null
    });
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ ...output, published: false, dryRun: true }, null, 2));
    saveState(config.stateFile, {
      lastSeverity: probeResult.classification.severity,
      lastFingerprint: probeResult.fingerprint,
      lastPublishedAt: state.data.lastPublishedAt ?? null
    });
    return;
  }

  const published = await publishEvent(config.pushmeBotUrl, config.pushmeApiKey, payload);
  console.log(JSON.stringify({ ...output, published: true, response: published }, null, 2));
  saveState(config.stateFile, {
    lastSeverity: probeResult.classification.severity,
    lastFingerprint: probeResult.fingerprint,
    lastPublishedAt: new Date().toISOString()
  });
}

async function main() {
  const config = loadConfig();
  const runtimeConfig = {
    ...config,
    nodeIdentity: await resolveNodeIdentity(config.nodeIdentity)
  };
  const args = parseArgs(process.argv);
  await executeProbe(runtimeConfig, args);
  if (args.once) return;
  setInterval(() => {
    executeProbe(runtimeConfig, args).catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    });
  }, runtimeConfig.intervalMs);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
