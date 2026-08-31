/**
 * Model discovery — fetch available models from upstream providers.
 *
 * Most OpenAI-compatible and many Anthropic proxy providers expose
 * GET /v1/models (or /models).  This module fetches that list,
 * caches it briefly, and returns a clean array of model IDs.
 */

import { logger } from '../utils/logger.js';
import { getActiveApiKey } from '../config/manager.js';
import { getSupportedProtocols } from './adapters.js';

// ─── In-memory cache ────────────────────────────────────────────────
const cache = new Map();       // providerName → { data, fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch models from a provider's upstream /v1/models endpoint.
 *
 * @param {Object} provider - Provider config object
 * @param {Object} [options]
 * @param {string} [options.providerName] - Name for logging/caching
 * @param {boolean} [options.skipCache=false] - Force fresh fetch
 * @returns {Promise<Array<{ id: string, object: string, created: number, owned_by: string }>>}
 */
export async function fetchProviderModels(provider, options = {}) {
  const { providerName = 'unknown', skipCache = false } = options;

  // Check cache
  if (!skipCache && cache.has(providerName)) {
    const cached = cache.get(providerName);
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.data;
    }
    cache.delete(providerName);
  }

  const modelsUrl = buildModelsUrl(provider);
  const headers = buildFetchHeaders(provider);

  logger.server('info', `[models-fetcher] Fetching models from ${providerName} → ${modelsUrl}`);

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.server('warn', `[models-fetcher] ${providerName} returned HTTP ${response.status}: ${body.substring(0, 200)}`);
      return [];
    }

    const json = await response.json();

    // OpenAI format: { object: "list", data: [{ id, object, ... }] }
    let models = [];
    if (json.data && Array.isArray(json.data)) {
      models = json.data.map(m => ({
        id: m.id,
        object: m.object || 'model',
        created: m.created || Math.floor(Date.now() / 1000),
        owned_by: m.owned_by || providerName,
      }));
    } else if (Array.isArray(json)) {
      // Some providers return a flat array
      models = json.map(m => ({
        id: typeof m === 'string' ? m : m.id,
        object: 'model',
        created: m.created || Math.floor(Date.now() / 1000),
        owned_by: m.owned_by || providerName,
      }));
    }

    // Cache the result
    cache.set(providerName, { data: models, fetchedAt: Date.now() });

    logger.server('info', `[models-fetcher] ${providerName}: found ${models.length} model(s)`);
    return models;
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      logger.server('warn', `[models-fetcher] ${providerName}: timeout fetching models`);
    } else {
      logger.server('warn', `[models-fetcher] ${providerName}: ${err.message}`);
    }
    return [];
  }
}

/**
 * Clear the model cache for a specific provider or all providers.
 */
export function clearModelCache(providerName = null) {
  if (providerName) {
    cache.delete(providerName);
  } else {
    cache.clear();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Build the /v1/models URL for a provider, handling different URL patterns:
 *   - https://seekai.cc/v1       → https://seekai.cc/v1/models
 *   - https://gorouter.app/v1    → https://gorouter.app/v1/models
 *   - https://api.openai.com     → https://api.openai.com/v1/models
 *   - https://example.com/v1/    → https://example.com/v1/models
 */
function buildModelsUrl(provider) {
  const base = provider.baseURL.replace(/\/+$/, '');

  // If URL already ends with /v1, just append /models
  if (/\/v1$/i.test(base)) {
    return `${base}/models`;
  }

  // For anthropic-native providers, try /v1/models anyway
  // (most proxy providers expose it regardless of type)
  return `${base}/v1/models`;
}

/**
 * Build headers for the models fetch request.
 */
function buildFetchHeaders(provider) {
  const headers = {
    'Content-Type': 'application/json',
  };

  // Works for both saved providers (accounts[]) and unsaved provider drafts
  // passed in during `provider add` (legacy `apiKey` field).
  const apiKey = getActiveApiKey(provider);

  if (getSupportedProtocols(provider)[0] === 'anthropic') {
    // Anthropic-native auth — x-api-key is primary, but also include Bearer
    // for proxy providers that accept either
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Include any custom headers from provider config
  if (provider.headers && typeof provider.headers === 'object') {
    Object.assign(headers, provider.headers);
  }

  return headers;
}
