import { v4 as uuidv4 } from 'uuid';

/**
 * Default config schema for ~/.abproxy/config.json
 */
export function createDefaultConfig() {
  return {
    port: 1986,
    localApiKey: `sk-local-${uuidv4().replace(/-/g, '')}`,
    defaultProvider: null,
    defaultModel: null,
    providers: {},
    aliases: {},
  };
}

/**
 * Validate a single account object
 */
export function validateAccount(account) {
  const errors = [];

  if (!account.name || typeof account.name !== 'string') {
    errors.push('Account name is required and must be a string');
  }
  if (!account.apiKey || typeof account.apiKey !== 'string') {
    errors.push('Account apiKey is required and must be a string');
  }
  if (account.isDefault !== undefined && typeof account.isDefault !== 'boolean') {
    errors.push('Account isDefault must be a boolean');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a provider object structure.
 * Supports both legacy (apiKey) and new (accounts[]) formats.
 */
export function validateProvider(provider) {
  const errors = [];

  if (!provider.type || !['anthropic-native', 'openai-compatible'].includes(provider.type)) {
    errors.push('Provider type must be "anthropic-native" or "openai-compatible"');
  }
  if (!provider.baseURL || typeof provider.baseURL !== 'string') {
    errors.push('Provider baseURL is required and must be a string');
  }

  // Must have either accounts[] or legacy apiKey
  const hasAccounts = Array.isArray(provider.accounts) && provider.accounts.length > 0;
  const hasApiKey = provider.apiKey && typeof provider.apiKey === 'string';

  if (!hasAccounts && !hasApiKey) {
    errors.push('Provider must have at least one account or an apiKey');
  }

  if (hasAccounts) {
    const defaultCount = provider.accounts.filter(a => a.isDefault).length;
    if (defaultCount > 1) {
      errors.push('Only one account can be marked as default');
    }
    for (let i = 0; i < provider.accounts.length; i++) {
      const result = validateAccount(provider.accounts[i]);
      if (!result.valid) {
        errors.push(...result.errors.map(e => `Account[${i}] "${provider.accounts[i].name || '?'}": ${e}`));
      }
    }
  }

  if (provider.aliases !== undefined) {
    errors.push('Provider-level "aliases" is no longer supported — create an alias via the alias menu instead');
  }
  if (provider.models && typeof provider.models !== 'object') {
    errors.push('Provider models must be an object');
  }
  if (provider.defaultModel !== undefined && provider.defaultModel !== null && typeof provider.defaultModel !== 'string') {
    errors.push('Provider defaultModel must be a string');
  }
  if (provider.protocols !== undefined) {
    const valid = ['openai', 'anthropic'];
    if (!Array.isArray(provider.protocols) || provider.protocols.length === 0 ||
        !provider.protocols.every(p => valid.includes(p))) {
      errors.push('Provider protocols must be a non-empty array of "openai" and/or "anthropic"');
    }
  }
  if (
    provider.defaultModel &&
    provider.models &&
    typeof provider.models === 'object' &&
    Object.keys(provider.models).length > 0 &&
    !provider.models[provider.defaultModel]
  ) {
    errors.push(`Provider defaultModel "${provider.defaultModel}" is not a configured model`);
  }
  if (provider.autoFetch !== undefined && typeof provider.autoFetch !== 'boolean') {
    errors.push('Provider autoFetch must be a boolean');
  }
  if (provider.headers && typeof provider.headers !== 'object') {
    errors.push('Provider headers must be an object');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Migrate a legacy provider (single apiKey) to the new accounts[] format.
 * Returns true if migration was performed.
 */
export function migrateProvider(provider) {
  let migrated = false;
  if (provider.apiKey && (!provider.accounts || provider.accounts.length === 0)) {
    provider.accounts = [
      { name: 'Default', apiKey: provider.apiKey, isDefault: true },
    ];
    delete provider.apiKey;
    migrated = true;
  }
  // Drop provider-level aliases (no longer a concept)
  if (provider.aliases !== undefined) {
    delete provider.aliases;
    migrated = true;
  }
  // Note: model-level aliases are extracted into config.aliases by
  // migrateConfig BEFORE this runs (order matters there).
  return migrated;
}

/**
 * Migrate the full config to the current schema:
 * - modelGroups → aliases (each member "provider:model" becomes a
 *   "provider/model" alias; a single-member group keeps its name if it
 *   follows provider/model form, otherwise name/name)
 * - model-level aliases → top-level "alias → provider:model" entries
 * - drop modelGroups, per-provider and per-model alias fields
 * Returns true if anything changed.
 */
export function migrateConfig(config) {
  let migrated = false;

  const aliases = {};

  // 1. Model-level aliases become top-level aliases — MUST happen before
  // migrateProvider strips the model.aliases fields below.
  for (const [pName, provider] of Object.entries(config.providers || {})) {
    for (const [mName, model] of Object.entries(provider.models || {})) {
      for (const alias of (model.aliases || [])) {
        if (!aliases[alias]) {
          aliases[alias] = { provider: pName, model: mName };
          migrated = true;
        }
      }
    }
  }

  // 2. modelGroups → aliases. Each member becomes "provider/model".
  for (const [gName, group] of Object.entries(config.modelGroups || {})) {
    const members = (group && Array.isArray(group.members)) ? group.members : [];
    if (members.length === 0) continue;
    for (const member of members) {
      const [pRef, mName] = member.split(':');
      if (!mName) continue;
      const aliasName = `${pRef}/${mName}`;
      if (!aliases[aliasName]) {
        aliases[aliasName] = { provider: pRef, model: mName };
        migrated = true;
      }
    }
    // Single-member group: also keep its own name as an alias
    if (members.length === 1) {
      const [pRef, mName] = members[0].split(':');
      if (mName && !aliases[gName]) {
        aliases[gName] = { provider: pRef, model: mName };
        migrated = true;
      }
    }
  }

  // 3. NOW strip legacy fields (apiKey → accounts, provider/model aliases)
  for (const provider of Object.values(config.providers || {})) {
    for (const model of Object.values(provider.models || {})) {
      if (model && model.aliases !== undefined) {
        delete model.aliases;
        migrated = true;
      }
    }
    if (migrateProvider(provider)) migrated = true;
  }

  if (config.modelGroups !== undefined) {
    delete config.modelGroups;
    migrated = true;
  }

  // Merge with any existing aliases (existing win — user-created)
  if (Object.keys(aliases).length > 0) {
    config.aliases = { ...aliases, ...(config.aliases || {}) };
  } else if (config.aliases === undefined) {
    config.aliases = {};
  }

  // Dangling provider/model alias references get pruned (provider deleted, etc.)
  if (config.aliases) {
    for (const [aName, alias] of Object.entries(config.aliases)) {
      const provider = (config.providers || {})[alias.provider];
      if (!provider || !provider.models || !provider.models[alias.model]) {
        delete config.aliases[aName];
        migrated = true;
      }
    }
  }

  return migrated;
}

/**
 * Validate a model object structure
 */
export function validateModel(model) {
  const errors = [];

  if (!model.realModel || typeof model.realModel !== 'string') {
    errors.push('Model realModel is required and must be a string');
  }
  if (model.aliases !== undefined) {
    errors.push('Model-level "aliases" is no longer supported — create an alias via the alias menu instead');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an alias object structure.
 * An alias is a virtual model name exposed to agents; it maps to a
 * provider and that provider's model, e.g. "gorouter/claude-opus-4-8".
 */
export function validateAlias(alias) {
  const errors = [];

  if (!alias.provider || typeof alias.provider !== 'string') {
    errors.push('Alias provider is required and must be a string');
  }
  if (!alias.model || typeof alias.model !== 'string') {
    errors.push('Alias model is required and must be a string');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate the full config structure
 */
export function validateConfig(config) {
  const errors = [];

  if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
    errors.push('Port must be a number between 1 and 65535');
  }
  if (!config.localApiKey || typeof config.localApiKey !== 'string') {
    errors.push('localApiKey is required');
  }
  if (config.defaultProvider !== undefined && config.defaultProvider !== null && typeof config.defaultProvider !== 'string') {
    errors.push('defaultProvider must be a string');
  }
  if (config.defaultProvider && config.providers && !config.providers[config.defaultProvider]) {
    errors.push(`defaultProvider "${config.defaultProvider}" does not match any configured provider`);
  }
  if (config.defaultModel !== undefined && config.defaultModel !== null && typeof config.defaultModel !== 'string') {
    errors.push('defaultModel must be a string');
  }
  if (typeof config.providers !== 'object') {
    errors.push('providers must be an object');
  }
  if (typeof config.aliases !== 'object') {
    errors.push('aliases must be an object');
  }

  // Validate each provider
  for (const [name, provider] of Object.entries(config.providers || {})) {
    const result = validateProvider(provider);
    if (!result.valid) {
      errors.push(...result.errors.map(e => `Provider "${name}": ${e}`));
    }

    // Validate each model within provider
    for (const [modelName, model] of Object.entries(provider.models || {})) {
      const modelResult = validateModel(model);
      if (!modelResult.valid) {
        errors.push(...modelResult.errors.map(e => `Provider "${name}" model "${modelName}": ${e}`));
      }
    }
  }

  // Validate each alias
  for (const [aliasName, alias] of Object.entries(config.aliases || {})) {
    const result = validateAlias(alias);
    if (!result.valid) {
      errors.push(...result.errors.map(e => `Alias "${aliasName}": ${e}`));
      continue;
    }
    // Reference check: provider + model must exist
    const provider = config.providers[alias.provider];
    if (!provider) {
      errors.push(`Alias "${aliasName}": provider "${alias.provider}" not found`);
    } else if (!provider.models || !provider.models[alias.model]) {
      errors.push(`Alias "${aliasName}": model "${alias.model}" not found on provider "${alias.provider}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}
