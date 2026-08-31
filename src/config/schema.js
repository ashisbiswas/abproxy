import { v4 as uuidv4 } from 'uuid';

/**
 * Default config schema for ~/.abproxy/config.json
 */
export function createDefaultConfig() {
  return {
    port: 1986,
    localApiKey: `sk-local-${uuidv4().replace(/-/g, '')}`,
    defaultModel: null,
    providers: {},
    modelGroups: {},
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

  if (provider.aliases && !Array.isArray(provider.aliases)) {
    errors.push('Provider aliases must be an array');
  }
  if (provider.models && typeof provider.models !== 'object') {
    errors.push('Provider models must be an object');
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
  if (provider.apiKey && (!provider.accounts || provider.accounts.length === 0)) {
    provider.accounts = [
      { name: 'Default', apiKey: provider.apiKey, isDefault: true },
    ];
    delete provider.apiKey;
    return true;
  }
  return false;
}

/**
 * Validate a model object structure
 */
export function validateModel(model) {
  const errors = [];

  if (!model.realModel || typeof model.realModel !== 'string') {
    errors.push('Model realModel is required and must be a string');
  }
  if (model.aliases && !Array.isArray(model.aliases)) {
    errors.push('Model aliases must be an array');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a model group object structure
 */
export function validateGroup(group) {
  const errors = [];

  if (!group.members || !Array.isArray(group.members) || group.members.length === 0) {
    errors.push('Group must have at least one member in format "provider:model"');
  } else {
    for (const member of group.members) {
      if (!member.includes(':')) {
        errors.push(`Invalid member format "${member}" — must be "provider:model"`);
      }
    }
  }

  if (group.strategy && !['failover', 'round-robin'].includes(group.strategy)) {
    errors.push('Group strategy must be "failover" or "round-robin"');
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
  if (typeof config.providers !== 'object') {
    errors.push('providers must be an object');
  }
  if (typeof config.modelGroups !== 'object') {
    errors.push('modelGroups must be an object');
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

  // Validate each group
  for (const [name, group] of Object.entries(config.modelGroups || {})) {
    const result = validateGroup(group);
    if (!result.valid) {
      errors.push(...result.errors.map(e => `Group "${name}": ${e}`));
    }
  }

  return { valid: errors.length === 0, errors };
}
