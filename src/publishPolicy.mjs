function clearPending(state) {
  return {
    ...state,
    pendingFingerprint: null,
    pendingCount: 0,
    pendingSeverity: null
  };
}

export function shouldDebounceDegraded(probeResult) {
  const classification = probeResult?.classification ?? {};
  if (classification.severity !== 'degraded') return false;

  const aggregate = probeResult?.aggregate ?? {};
  const profiles = Array.isArray(probeResult?.profiles) ? probeResult.profiles : [];
  const diagnosis = probeResult?.diagnosis ?? {};

  const maxPacketLossPct = Number(aggregate.maxPacketLossPct ?? 0) || 0;
  const impactedCount = Number(classification.impactedCount ?? 0) || 0;
  const impactedGroupCount = Array.isArray(diagnosis.impactedGroups) ? diagnosis.impactedGroups.length : 0;
  const hasHardFailure = profiles.some(
    (profile) =>
      profile?.severity === 'down' ||
      profile?.dnsError ||
      profile?.httpError ||
      profile?.packetError ||
      profile?.providerStatusSeverity
  );

  if (hasHardFailure) return false;
  if (maxPacketLossPct > 0) return false;
  if (impactedGroupCount >= 2) return false;
  if (impactedCount >= 4) return false;

  return true;
}

export function decidePublication(state, probeResult, options = {}) {
  const mode = String(options.publishMode || 'changes').toLowerCase();
  const debounceCountRequired = Math.max(1, Number(options.debounceCountRequired ?? 2) || 2);
  const normalizedState = {
    lastSeverity: state?.lastSeverity ?? null,
    lastFingerprint: state?.lastFingerprint ?? null,
    lastPublishedAt: state?.lastPublishedAt ?? null,
    pendingFingerprint: state?.pendingFingerprint ?? null,
    pendingCount: Number(state?.pendingCount ?? 0) || 0,
    pendingSeverity: state?.pendingSeverity ?? null
  };

  if (mode === 'always') {
    return {
      publish: true,
      reason: 'publish mode always',
      nextState: clearPending(normalizedState)
    };
  }

  const fingerprint = probeResult?.fingerprint ?? null;
  const severity = probeResult?.classification?.severity ?? null;

  if (!fingerprint || !severity) {
    return {
      publish: false,
      reason: 'missing probe fingerprint',
      nextState: clearPending(normalizedState)
    };
  }

  if (normalizedState.lastFingerprint === fingerprint) {
    return {
      publish: false,
      reason: 'no state change',
      nextState: clearPending(normalizedState)
    };
  }

  if (severity === 'ok') {
    if (normalizedState.lastSeverity && normalizedState.lastSeverity !== 'ok') {
      return {
        publish: true,
        reason: 'published recovery',
        nextState: clearPending(normalizedState)
      };
    }
    return {
      publish: false,
      reason: 'healthy with no published incident',
      nextState: clearPending(normalizedState)
    };
  }

  if (severity === 'down' || !shouldDebounceDegraded(probeResult)) {
    return {
      publish: true,
      reason: severity === 'down' ? 'hard outage' : 'significant degradation',
      nextState: clearPending(normalizedState)
    };
  }

  const nextPendingCount =
    normalizedState.pendingFingerprint === fingerprint ? normalizedState.pendingCount + 1 : 1;

  if (nextPendingCount >= debounceCountRequired) {
    return {
      publish: true,
      reason: `degraded state persisted for ${nextPendingCount} probes`,
      nextState: clearPending(normalizedState)
    };
  }

  return {
    publish: false,
    reason: nextPendingCount === 1 ? 'waiting for degraded confirmation' : 'waiting for degraded persistence',
    nextState: {
      ...normalizedState,
      pendingFingerprint: fingerprint,
      pendingCount: nextPendingCount,
      pendingSeverity: severity
    }
  };
}
