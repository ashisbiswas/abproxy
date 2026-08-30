import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDefaultConfig, validateConfig } from './schema.js';
import { logger } from '../utils/logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.abproxy');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Ensure config directory and file exist
 */
export function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig = createDefaultConfig();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    logger.success(`Created default config at ${CONFIG_FILE}`);
    return defaultConfig;
  }
  return getConfig();
}

/**
 * Read config from disk
 */
export function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return ensureConfig();
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Write config to disk
 */
export function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Get config file path
 */
export function getConfigPath() {
  return CONFIG_FILE;
}

// ─── Provider CRUD ───────────────────────────────────────────────────

export function addProvider(name, provider) {
  const config = getConfig();
  if (config.providers[name]) {
    throw new Error(`Provider "${name}" already exists`);
  }
  config.providers[name] = {
    aliases: provider.aliases || [],
    type: provider.type,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    models: provider.models || {},
    autoFetch: provider.autoFetch !== undefined ? provider.autoFetch : true,
    ...(provider.headers ? { headers: provider.headers } : {}),
  };
  saveConfig(config);
  return config;
}

export function editProvider(name, updates) {
  const config = getConfig();
  const provider = resolveProvider(config, name);
  if (!provider) {
    throw new Error(`Provider "${name}" not found`);
  }
  const resolvedName = resolveProviderName(config, name);
  Object.assign(config.providers[resolvedName], updates);
  saveConfig(config);
  return config;
}

export function deleteProvider(name) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, name);
  if (!resolvedName) {
    throw new Error(`Provider "${name}" not found`);
  }
  delete config.providers[resolvedName];

  // Cascade: remove from model groups
  for (const [groupName, group] of Object.entries(config.modelGroups)) {
    group.members = group.members.filter(m => !m.startsWith(`${resolvedName}:`));
    if (group.members.length === 0) {
      delete config.modelGroups[groupName];
    }
  }

  saveConfig(config);
  return config;
}

export function getProvider(name) {
  const config = getConfig();
  return resolveProvider(config, name);
}

export function listProviders() {
  const config = getConfig();
  return config.providers;
}

// ─── Model CRUD ──────────────────────────────────────────────────────

export function addModel(providerName, modelName, model) {
  const config = getConfig();
  const resolvedProvider = resolveProviderName(config, providerName);
  if (!resolvedProvider) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedProvider];
  if (provider.models[modelName]) {
    throw new Error(`Model "${modelName}" already exists on provider "${resolvedProvider}"`);
  }
  provider.models[modelName] = {
    realModel: model.realModel,
    aliases: model.aliases || [],
  };
  saveConfig(config);
  return config;
}

export function editModel(providerName, modelName, updates) {
  const config = getConfig();
  const resolvedProvider = resolveProviderName(config, providerName);
  if (!resolvedProvider) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedProvider];
  if (!provider.models[modelName]) {
    throw new Error(`Model "${modelName}" not found on provider "${resolvedProvider}"`);
  }
  Object.assign(provider.models[modelName], updates);
  saveConfig(config);
  return config;
}

export function deleteModel(providerName, modelName) {
  const config = getConfig();
  const resolvedProvider = resolveProviderName(config, providerName);
  if (!resolvedProvider) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedProvider];
  if (!provider.models[modelName]) {
    throw new Error(`Model "${modelName}" not found on provider "${resolvedProvider}"`);
  }
  delete provider.models[modelName];

  // Cascade: remove from model groups
  const memberKey = `${resolvedProvider}:${modelName}`;
  for (const [groupName, group] of Object.entries(config.modelGroups)) {
    group.members = group.members.filter(m => m !== memberKey);
    if (group.members.length === 0) {
      delete config.modelGroups[groupName];
    }
  }

  saveConfig(config);
  return config;
}

export function addModelAlias(modelName, alias) {
  const config = getConfig();
  // Find which provider has this model
  for (const [, provider] of Object.entries(config.providers)) {
    if (provider.models[modelName]) {
      if (!provider.models[modelName].aliases) {
        provider.models[modelName].aliases = [];
      }
      if (!provider.models[modelName].aliases.includes(alias)) {
        provider.models[modelName].aliases.push(alias);
      }
      saveConfig(config);
      return config;
    }
  }
  throw new Error(`Model "${modelName}" not found on any provider`);
}

export function setDefaultModel(modelName) {
  const config = getConfig();
  config.defaultModel = modelName;
  saveConfig(config);
  return config;
}

export function listModels(providerName = null) {
  const config = getConfig();
  const result = [];

  const providers = providerName
    ? { [resolveProviderName(config, providerName) || providerName]: config.providers[resolveProviderName(config, providerName) || providerName] }
    : config.providers;

  for (const [pName, provider] of Object.entries(providers)) {
    if (!provider) continue;
    for (const [mName, model] of Object.entries(provider.models || {})) {
      result.push({
        provider: pName,
        name: mName,
        realModel: model.realModel,
        aliases: model.aliases || [],
        isDefault: config.defaultModel === mName,
      });
    }
  }

  return result;
}

/**
 * Import fetched models into a provider's config.
 * Used during `provider add` auto-fetch and `provider sync`.
 *
 * @param {string} providerName - Resolved provider name
 * @param {Array<{ id: string, alias?: string }>} selectedModels - Models to import
 * @returns {Object} Updated config
 */
export function importFetchedModels(providerName, selectedModels) {
  const config = getConfig();
  const resolved = resolveProviderName(config, providerName) || providerName;
  const provider = config.providers[resolved];
  if (!provider) {
    throw new Error(`Provider "${providerName}" not found`);
  }

  let added = 0;
  for (const m of selectedModels) {
    const modelName = m.alias || m.id;
    if (!provider.models[modelName]) {
      provider.models[modelName] = {
        realModel: m.id,
        aliases: [],
      };
      added++;
    }
  }

  saveConfig(config);
  return { config, added };
}

/**
 * Sync provider models — merge fetched models into existing config.
 * New models get added, existing models are preserved with their aliases.
 *
 * @param {string} providerName - Resolved provider name
 * @param {Array<{ id: string }>} fetchedModels - All models from upstream
 * @returns {{ added: string[], existing: string[], stale: string[] }}
 */
export function syncProviderModels(providerName, fetchedModels) {
  const config = getConfig();
  const resolved = resolveProviderName(config, providerName) || providerName;
  const provider = config.providers[resolved];
  if (!provider) {
    throw new Error(`Provider "${providerName}" not found`);
  }

  const fetchedIds = new Set(fetchedModels.map(m => m.id));
  const existingRealModels = new Map(); // realModel → modelName
  for (const [name, model] of Object.entries(provider.models || {})) {
    existingRealModels.set(model.realModel, name);
  }

  const added = [];
  const existing = [];
  const stale = [];

  // Find new models to add
  for (const m of fetchedModels) {
    if (existingRealModels.has(m.id)) {
      existing.push(m.id);
    } else {
      // Check if we already have this model under a different name
      const alreadyExists = Object.values(provider.models || {}).some(
        model => model.realModel === m.id
      );
      if (!alreadyExists) {
        added.push(m.id);
      } else {
        existing.push(m.id);
      }
    }
  }

  // Find stale models (in config but not upstream)
  for (const [name, model] of Object.entries(provider.models || {})) {
    if (!fetchedIds.has(model.realModel)) {
      stale.push(name);
    }
  }

  return { added, existing, stale };
}


// ─── Group CRUD ──────────────────────────────────────────────────────

export function addGroup(name, group) {
  const config = getConfig();
  if (config.modelGroups[name]) {
    throw new Error(`Group "${name}" already exists`);
  }
  config.modelGroups[name] = {
    members: group.members,
    strategy: group.strategy || 'failover',
    default: group.default || false,
  };
  saveConfig(config);
  return config;
}

export function editGroup(name, updates) {
  const config = getConfig();
  if (!config.modelGroups[name]) {
    throw new Error(`Group "${name}" not found`);
  }
  Object.assign(config.modelGroups[name], updates);
  saveConfig(config);
  return config;
}

export function deleteGroup(name) {
  const config = getConfig();
  if (!config.modelGroups[name]) {
    throw new Error(`Group "${name}" not found`);
  }
  delete config.modelGroups[name];
  saveConfig(config);
  return config;
}

export function listGroups() {
  const config = getConfig();
  return config.modelGroups;
}

// ─── Alias Resolution ────────────────────────────────────────────────

/**
 * Resolve a provider name or alias to the canonical provider name
 */
export function resolveProviderName(config, nameOrAlias) {
  if (config.providers[nameOrAlias]) return nameOrAlias;
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.aliases && provider.aliases.includes(nameOrAlias)) {
      return name;
    }
  }
  return null;
}

/**
 * Resolve a provider name or alias to the provider object
 */
export function resolveProvider(config, nameOrAlias) {
  const name = resolveProviderName(config, nameOrAlias);
  return name ? config.providers[name] : null;
}

/**
 * Resolve a model name or alias to { providerName, modelName, model }
 * Searches across all providers.
 */
export function resolveModelAlias(config, nameOrAlias) {
  // Direct match: check all providers for this model name
  for (const [pName, provider] of Object.entries(config.providers)) {
    if (provider.models[nameOrAlias]) {
      return { providerName: pName, modelName: nameOrAlias, model: provider.models[nameOrAlias] };
    }
  }
  // Alias match: check all providers for alias
  for (const [pName, provider] of Object.entries(config.providers)) {
    for (const [mName, model] of Object.entries(provider.models || {})) {
      if (model.aliases && model.aliases.includes(nameOrAlias)) {
        return { providerName: pName, modelName: mName, model };
      }
    }
  }
  return null;
}
