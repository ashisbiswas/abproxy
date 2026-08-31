import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDefaultConfig, validateConfig, migrateProvider, migrateConfig } from './schema.js';
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
 * Read config from disk. Automatically migrates legacy providers.
 */
export function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return ensureConfig();
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  const config = JSON.parse(raw);

  // Auto-migrate to the current schema (apiKey → accounts[], groups → aliases,
  // per-provider/per-model alias fields dropped). Persisted if anything changed.
  if (migrateConfig(config)) {
    saveConfig(config);
  }

  return config;
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

// ─── Active API Key Helper ──────────────────────────────────────────

/**
 * Get the active API key for a provider.
 * Returns the default account's key, or the first account's key if none is default.
 * Falls back to legacy apiKey field if no accounts exist.
 */
export function getActiveApiKey(provider) {
  if (provider.accounts && provider.accounts.length > 0) {
    const defaultAccount = provider.accounts.find(a => a.isDefault);
    return defaultAccount ? defaultAccount.apiKey : provider.accounts[0].apiKey;
  }
  // Legacy fallback
  return provider.apiKey || '';
}

/**
 * Get the active account name for a provider.
 */
export function getActiveAccountName(provider) {
  if (provider.accounts && provider.accounts.length > 0) {
    const defaultAccount = provider.accounts.find(a => a.isDefault);
    return defaultAccount ? defaultAccount.name : provider.accounts[0].name;
  }
  return 'Default';
}

// ─── Default Provider / Default Model ────────────────────────────────

/**
 * Set (or clear, with null) the global default provider.
 * When set, requests without a model use this provider's defaultModel.
 */
export function setDefaultProvider(providerName) {
  const config = getConfig();
  if (providerName === null || providerName === undefined) {
    config.defaultProvider = null;
    saveConfig(config);
    return config;
  }
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  config.defaultProvider = resolvedName;
  saveConfig(config);
  return config;
}

/**
 * Set (or clear, with null) a provider's own default model.
 * Used when this provider is the default provider, and for display.
 */
export function setProviderDefaultModel(providerName, modelName) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedName];

  if (modelName === null || modelName === undefined) {
    delete provider.defaultModel;
    saveConfig(config);
    return config;
  }

  if (!provider.models || !provider.models[modelName]) {
    throw new Error(`Model "${modelName}" not found on provider "${resolvedName}"`);
  }
  provider.defaultModel = modelName;
  saveConfig(config);
  return config;
}

/**
 * Effective default model for requests that don't specify one.
 *
 * Priority:
 *   1. defaultProvider + that provider's defaultModel (pinned to the provider)
 *   2. Global defaultModel (resolved through the normal name/alias/group chain)
 *
 * Returns { providerName, modelName } — providerName is null for the global fallback,
 * or null when no default is configured at all.
 */
export function getEffectiveDefaultModel(config) {
  if (config.defaultProvider) {
    const pName = resolveProviderName(config, config.defaultProvider) || config.defaultProvider;
    const provider = config.providers[pName];
    if (provider && provider.defaultModel && provider.models && provider.models[provider.defaultModel]) {
      return { providerName: pName, modelName: provider.defaultModel };
    }
  }
  if (config.defaultModel) {
    return { providerName: null, modelName: config.defaultModel };
  }
  return null;
}

/**
 * Formatted effective default for display: "provider › model", "model", or null.
 * Note: the "provider › model" form is display-only — it is not a resolvable model id.
 */
export function formatDefaultModel(config) {
  const def = getEffectiveDefaultModel(config);
  if (!def) return null;
  return def.providerName ? `${def.providerName} › ${def.modelName}` : def.modelName;
}

// ─── Provider CRUD ───────────────────────────────────────────────────

export function addProvider(name, provider) {
  const config = getConfig();
  if (config.providers[name]) {
    throw new Error(`Provider "${name}" already exists`);
  }

  const providerData = {
    type: provider.type,
    baseURL: provider.baseURL,
    models: provider.models || {},
    autoFetch: provider.autoFetch !== undefined ? provider.autoFetch : true,
    ...(provider.protocols ? { protocols: provider.protocols } : {}),
    ...(provider.headers ? { headers: provider.headers } : {}),
  };

  // Models carry only realModel now (aliases are top-level config.aliases)
  for (const model of Object.values(providerData.models)) {
    if (model && model.aliases !== undefined) delete model.aliases;
  }

  // Use accounts array if provided, otherwise create from single apiKey
  if (provider.accounts && provider.accounts.length > 0) {
    providerData.accounts = provider.accounts;
  } else if (provider.apiKey) {
    providerData.accounts = [
      { name: 'Default', apiKey: provider.apiKey, isDefault: true },
    ];
  } else {
    providerData.accounts = [];
  }

  config.providers[name] = providerData;
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

  // Clear the global default provider if it was this one
  if (config.defaultProvider === resolvedName) {
    config.defaultProvider = null;
  }

  // Cascade: prune aliases pointing at this provider
  pruneAliases(config);

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

// ─── Account CRUD ────────────────────────────────────────────────────

/**
 * Add an account to a provider
 */
export function addAccount(providerName, account) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedName];

  if (!provider.accounts) {
    provider.accounts = [];
  }

  // Check for duplicate name
  if (provider.accounts.some(a => a.name === account.name)) {
    throw new Error(`Account "${account.name}" already exists on provider "${resolvedName}"`);
  }

  // If this is the first account or explicitly default, set as default
  const isDefault = provider.accounts.length === 0 || !!account.isDefault;
  if (isDefault) {
    // Clear other defaults
    for (const a of provider.accounts) {
      a.isDefault = false;
    }
  }

  provider.accounts.push({
    name: account.name,
    apiKey: account.apiKey,
    isDefault,
  });

  saveConfig(config);
  return config;
}

/**
 * Edit an account on a provider
 */
export function editAccount(providerName, accountName, updates) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedName];
  const account = (provider.accounts || []).find(a => a.name === accountName);
  if (!account) {
    throw new Error(`Account "${accountName}" not found on provider "${resolvedName}"`);
  }

  if (updates.name !== undefined) account.name = updates.name;
  if (updates.apiKey !== undefined) account.apiKey = updates.apiKey;

  saveConfig(config);
  return config;
}

/**
 * Delete an account from a provider
 */
export function deleteAccount(providerName, accountName) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedName];

  const idx = (provider.accounts || []).findIndex(a => a.name === accountName);
  if (idx === -1) {
    throw new Error(`Account "${accountName}" not found on provider "${resolvedName}"`);
  }

  const wasDefault = provider.accounts[idx].isDefault;
  provider.accounts.splice(idx, 1);

  // If we deleted the default, promote the first remaining account
  if (wasDefault && provider.accounts.length > 0) {
    provider.accounts[0].isDefault = true;
  }

  saveConfig(config);
  return config;
}

/**
 * Set the default account for a provider
 */
export function setDefaultAccount(providerName, accountName) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  const provider = config.providers[resolvedName];

  const account = (provider.accounts || []).find(a => a.name === accountName);
  if (!account) {
    throw new Error(`Account "${accountName}" not found on provider "${resolvedName}"`);
  }

  // Clear all, then set the one
  for (const a of provider.accounts) {
    a.isDefault = false;
  }
  account.isDefault = true;

  saveConfig(config);
  return config;
}

/**
 * List accounts for a provider
 */
export function listAccounts(providerName) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    throw new Error(`Provider "${providerName}" not found`);
  }
  return config.providers[resolvedName].accounts || [];
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

  // Clear the provider default if it pointed at the deleted model
  if (provider.defaultModel === modelName) {
    delete provider.defaultModel;
  }

  // Cascade: prune aliases pointing at the deleted model
  pruneAliases(config);

  saveConfig(config);
  return config;
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
        isDefault: config.defaultModel === mName,
        isProviderDefault: provider.defaultModel === mName,
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


// ─── Alias CRUD ──────────────────────────────────────────────────────
// Aliases are the virtual model names agents see at /v1/models.
// Each maps to one provider + one of its models, e.g.
//   "gorouter/claude-opus-4-8" → { provider: "GoRouter", model: "claude-opus-4-8" }

/**
 * Create an alias. Suggested form: "provider/model-name".
 * The provider/model parts are validated against the config.
 */
export function addAlias(aliasName, { provider, model }) {
  const config = getConfig();
  if (!aliasName || typeof aliasName !== 'string') {
    throw new Error('Alias name is required');
  }
  if (config.aliases[aliasName]) {
    throw new Error(`Alias "${aliasName}" already exists`);
  }
  const resolvedName = resolveProviderName(config, provider);
  if (!resolvedName) {
    throw new Error(`Provider "${provider}" not found`);
  }
  const providerObj = config.providers[resolvedName];
  if (!providerObj.models || !providerObj.models[model]) {
    throw new Error(`Model "${model}" not found on provider "${resolvedName}"`);
  }
  config.aliases[aliasName] = { provider: resolvedName, model };
  saveConfig(config);
  return config;
}

export function editAlias(aliasName, updates) {
  const config = getConfig();
  const alias = config.aliases[aliasName];
  if (!alias) {
    throw new Error(`Alias "${aliasName}" not found`);
  }
  const newProvider = updates.provider !== undefined ? updates.provider : alias.provider;
  const newModel = updates.model !== undefined ? updates.model : alias.model;

  const resolvedName = resolveProviderName(config, newProvider);
  if (!resolvedName) {
    throw new Error(`Provider "${newProvider}" not found`);
  }
  const providerObj = config.providers[resolvedName];
  if (!providerObj.models || !providerObj.models[newModel]) {
    throw new Error(`Model "${newModel}" not found on provider "${resolvedName}"`);
  }

  // Handle rename
  delete config.aliases[aliasName];
  const targetName = updates.name !== undefined ? updates.name : aliasName;
  config.aliases[targetName] = { provider: resolvedName, model: newModel };
  saveConfig(config);
  return config;
}

export function deleteAlias(aliasName) {
  const config = getConfig();
  if (!config.aliases[aliasName]) {
    throw new Error(`Alias "${aliasName}" not found`);
  }
  delete config.aliases[aliasName];
  saveConfig(config);
  return config;
}

export function listAliases() {
  const config = getConfig();
  return config.aliases || {};
}

/**
 * Cascade helper — prune aliases pointing at a provider that no longer
 * exists, or a model that was removed from its provider.
 */
function pruneAliases(config) {
  let changed = false;
  for (const [aName, alias] of Object.entries(config.aliases || {})) {
    const provider = config.providers[alias.provider];
    if (!provider || !provider.models || !provider.models[alias.model]) {
      delete config.aliases[aName];
      changed = true;
    }
  }
  return changed;
}

// ─── Alias Resolution ────────────────────────────────────────────────

/**
 * Resolve a provider name to the canonical provider name.
 * (Provider-level alias fields are gone — exact name match only.)
 */
export function resolveProviderName(config, name) {
  return config.providers[name] ? name : null;
}

/**
 * Resolve a provider name to the provider object
 */
export function resolveProvider(config, name) {
  return config.providers[name] || null;
}

/**
 * Resolve a top-level alias name to { aliasName, providerName, modelName, model }
 * Aliases are the names agents see in /v1/models.
 */
export function resolveAlias(config, aliasName) {
  const alias = (config.aliases || {})[aliasName];
  if (!alias) return null;
  const provider = config.providers[alias.provider];
  const model = provider?.models?.[alias.model];
  if (!model) return null;
  return { aliasName, providerName: alias.provider, modelName: alias.model, model };
}

/**
 * Resolve a model name within a provider (exact name only — per-model
 * alias fields are gone; use top-level aliases instead).
 */
export function resolveModelAlias(config, nameOrAlias) {
  for (const [pName, provider] of Object.entries(config.providers)) {
    if (provider.models && provider.models[nameOrAlias]) {
      return { providerName: pName, modelName: nameOrAlias, model: provider.models[nameOrAlias] };
    }
  }
  return null;
}
