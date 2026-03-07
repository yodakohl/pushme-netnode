#!/usr/bin/env node
import { loadConfig } from './config.mjs';
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

function shouldPublish(mode, previousSeverity, nextSeverity) {
  if (mode === 'always') return true;
  return previousSeverity !== nextSeverity;
}

async function executeProbe(config, args) {
  const state = loadState(config.stateFile);
  const previousSeverity = state.data.lastSeverity ?? null;
  const { metrics, classification } = await runProbe(config);
  const payload = buildEventPayload(config, metrics, classification, previousSeverity);

  const output = {
    severity: classification.severity,
    previousSeverity,
    metrics,
    payload
  };

  if (!shouldPublish(config.publishMode, previousSeverity, classification.severity)) {
    console.log(JSON.stringify({ ...output, skipped: true, reason: 'no state change' }, null, 2));
    saveState(config.stateFile, {
      lastSeverity: classification.severity,
      lastPublishedAt: state.data.lastPublishedAt ?? null
    });
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ ...output, published: false, dryRun: true }, null, 2));
    saveState(config.stateFile, {
      lastSeverity: classification.severity,
      lastPublishedAt: state.data.lastPublishedAt ?? null
    });
    return;
  }

  const published = await publishEvent(config.pushmeBotUrl, config.pushmeApiKey, payload);
  console.log(JSON.stringify({ ...output, published: true, response: published }, null, 2));
  saveState(config.stateFile, {
    lastSeverity: classification.severity,
    lastPublishedAt: new Date().toISOString()
  });
}

async function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv);
  await executeProbe(config, args);
  if (args.once) return;
  setInterval(() => {
    executeProbe(config, args).catch((error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    });
  }, config.intervalMs);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

