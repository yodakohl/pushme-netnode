#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { resolveNodeIdentity } from './identity.mjs';
import { runProbe, buildEventPayload } from './netnode.mjs';
import { decidePublication } from './publishPolicy.mjs';
import { publishEvent, reportNetnodeStartup } from './pushme.mjs';
import { loadState, saveState } from './state.mjs';

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    once: args.has('--once'),
    dryRun: args.has('--dry-run')
  };
}

async function reportStartup(config, state) {
  const response = await reportNetnodeStartup(config.pushmeBotUrl, config.pushmeApiKey, {
    nodeVersion: config.nodeVersion,
    releaseChannel: config.releaseChannel,
    image: config.image,
    stateSchemaVersion: state.schemaVersion
  });
  const startupLog = {
    startupReported: true,
    nodeVersion: config.nodeVersion,
    releaseChannel: config.releaseChannel,
    image: config.image,
    stateSchemaVersion: state.schemaVersion,
    updateAvailable: Boolean(response.updateAvailable),
    latestVersion: response.latestVersion ?? null,
    minSupportedVersion: response.minSupportedVersion ?? null,
    updateImage: response.image ?? null
  };
  console.log(JSON.stringify(startupLog, null, 2));
  if (response.updateAvailable) {
    console.warn(
      `[pushme-netnode] update available: current=${config.nodeVersion} latest=${response.latestVersion ?? 'unknown'} min_supported=${response.minSupportedVersion ?? 'unknown'} image=${response.image ?? 'unknown'}`
    );
  }
}

async function executeProbe(config, args) {
  const state = loadState(config.stateFile);
  if (state.migrated) {
    saveState(config.stateFile, state.data);
  }
  const previousSeverity = state.data.lastSeverity ?? null;
  const previousFingerprint = state.data.lastFingerprint ?? null;
  const probeResult = await runProbe(config);
  const payload = buildEventPayload(config, probeResult, state.data);
  const decision = decidePublication(state.data, probeResult, {
    publishMode: config.publishMode
  });

  const output = {
    severity: probeResult.classification.severity,
    previousSeverity,
    previousFingerprint,
    fingerprint: probeResult.fingerprint,
    publicationReason: decision.reason,
    profiles: probeResult.profiles,
    aggregate: probeResult.aggregate,
    payload
  };

  if (!decision.publish) {
    console.log(JSON.stringify({ ...output, skipped: true, reason: decision.reason }, null, 2));
    saveState(config.stateFile, decision.nextState);
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ ...output, published: false, dryRun: true }, null, 2));
    saveState(config.stateFile, {
      ...decision.nextState,
      lastSeverity: probeResult.classification.severity,
      lastFingerprint: probeResult.fingerprint,
      lastPublishedAt: state.data.lastPublishedAt ?? null
    });
    return;
  }

  const published = await publishEvent(config.pushmeBotUrl, config.pushmeApiKey, payload);
  console.log(JSON.stringify({ ...output, published: true, response: published }, null, 2));
  saveState(config.stateFile, {
    ...decision.nextState,
    lastSeverity: probeResult.classification.severity,
    lastFingerprint: probeResult.fingerprint,
    lastPublishedAt: new Date().toISOString()
  });
}

async function main() {
  const config = loadConfig();
  const state = loadState(config.stateFile);
  if (state.migrated) {
    saveState(config.stateFile, state.data);
  }
  const runtimeConfig = {
    ...config,
    nodeIdentity: await resolveNodeIdentity(config.nodeIdentity)
  };
  const args = parseArgs(process.argv);
  try {
    await reportStartup(runtimeConfig, state.data);
  } catch (error) {
    console.error(`[pushme-netnode] startup report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
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
