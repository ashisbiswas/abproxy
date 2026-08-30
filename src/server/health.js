/**
 * Per-provider health tracking — in-memory failure timestamps and request counts.
 */

const providerHealth = new Map();

let globalRequestCount = 0;
let startTime = Date.now();

/**
 * Get or initialize health state for a provider
 */
function getState(providerName) {
  if (!providerHealth.has(providerName)) {
    providerHealth.set(providerName, {
      healthy: true,
      lastFailure: null,
      failureReason: null,
      consecutiveFailures: 0,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
    });
  }
  return providerHealth.get(providerName);
}

/**
 * Record a successful request
 */
export function recordSuccess(providerName) {
  const state = getState(providerName);
  state.healthy = true;
  state.consecutiveFailures = 0;
  state.requestCount++;
  state.successCount++;
  globalRequestCount++;
}

/**
 * Record a failed request
 */
export function recordFailure(providerName, reason) {
  const state = getState(providerName);
  state.lastFailure = Date.now();
  state.failureReason = reason;
  state.consecutiveFailures++;
  state.requestCount++;
  state.failureCount++;
  globalRequestCount++;

  // Mark unhealthy after consecutive failures
  if (state.consecutiveFailures >= 2) {
    state.healthy = false;
  }
}

/**
 * Check if a provider should be skipped (cooling down)
 * Default cooldown: 60 seconds after failure
 */
export function shouldSkip(providerName, cooldownMs = 60000) {
  const state = getState(providerName);
  if (!state.lastFailure) return false;
  if (state.healthy) return false;

  const elapsed = Date.now() - state.lastFailure;
  if (elapsed > cooldownMs) {
    // Cooldown expired — give it another chance
    state.healthy = true;
    return false;
  }

  return true;
}

/**
 * Get remaining cooldown time in seconds
 */
export function getCooldownRemaining(providerName, cooldownMs = 60000) {
  const state = getState(providerName);
  if (!state.lastFailure || state.healthy) return 0;
  const elapsed = Date.now() - state.lastFailure;
  const remaining = Math.max(0, cooldownMs - elapsed);
  return Math.ceil(remaining / 1000);
}

/**
 * Get health status for all providers
 */
export function getAllHealth() {
  const result = {};
  for (const [name, state] of providerHealth.entries()) {
    const cooldown = getCooldownRemaining(name);
    result[name] = {
      healthy: state.healthy,
      reason: state.healthy
        ? null
        : `${state.failureReason}${cooldown > 0 ? `, cooling down ~${cooldown}s` : ''}`,
      consecutiveFailures: state.consecutiveFailures,
      requestCount: state.requestCount,
      successCount: state.successCount,
      failureCount: state.failureCount,
    };
  }
  return result;
}

/**
 * Get global stats
 */
export function getGlobalStats() {
  return {
    requestCount: globalRequestCount,
    uptime: (Date.now() - startTime) / 1000,
  };
}

/**
 * Reset all health state (for testing)
 */
export function resetHealth() {
  providerHealth.clear();
  globalRequestCount = 0;
  startTime = Date.now();
}
