/**
 * Alias resolution and model group resolution for incoming requests.
 * Takes a model name (which may be an alias) and resolves it to
 * an ordered list of { providerName, modelName, realModel, provider } targets.
 */

import { resolveModelAlias, resolveProviderName, getEffectiveDefaultModel } from '../config/manager.js';

/**
 * Resolve a model identifier from a request to an ordered list of targets.
 *
 * Resolution order:
 * 0. No model given → default provider's defaultModel (pinned to that provider),
 *    else global defaultModel
 * 1. Check model groups — if the model name matches a group, return all members
 * 2. Check direct model name or alias across all providers
 * 3. If model matches "provider:model" format, resolve within that provider
 * 4. Try matching by realModel name
 *
 * Returns: Array<{ providerName, modelName, realModel, provider }>
 */
export function resolveTargets(config, requestModel) {
  let model = requestModel;
  let pinnedProvider = null;

  if (!model) {
    const def = getEffectiveDefaultModel(config);
    if (!def) {
      throw new Error('No model specified and no default model configured');
    }
    model = def.modelName;
    pinnedProvider = def.providerName;
  }

  // Default-provider pinning: use exactly the default provider's default model
  if (pinnedProvider) {
    const provider = config.providers[pinnedProvider];
    const modelObj = provider && provider.models ? provider.models[model] : null;
    if (!modelObj) {
      throw new Error(`Default model "${model}" not found on default provider "${pinnedProvider}"`);
    }
    return [{
      providerName: pinnedProvider,
      modelName: model,
      realModel: modelObj.realModel,
      provider,
    }];
  }

  const targets = [];

  // 1. Check model groups
  if (config.modelGroups && config.modelGroups[model]) {
    const group = config.modelGroups[model];
    for (const memberRef of group.members) {
      const [providerRef, modelRef] = memberRef.split(':');
      const providerName = resolveProviderName(config, providerRef) || providerRef;
      const provider = config.providers[providerName];
      if (!provider) continue;
      const modelObj = provider.models[modelRef];
      if (!modelObj) continue;

      targets.push({
        providerName,
        modelName: modelRef,
        realModel: modelObj.realModel,
        provider,
      });
    }

    if (targets.length > 0) return targets;
  }

  // Also check group names via alias — the request model might be an alias
  // that maps to a model name that has a group
  for (const [groupName, group] of Object.entries(config.modelGroups || {})) {
    // Check if any model alias across providers matches
    const resolved = resolveModelAlias(config, model);
    if (resolved && groupName === resolved.modelName) {
      for (const memberRef of group.members) {
        const [providerRef, modelRef] = memberRef.split(':');
        const providerName = resolveProviderName(config, providerRef) || providerRef;
        const provider = config.providers[providerName];
        if (!provider) continue;
        const modelObj = provider.models[modelRef];
        if (!modelObj) continue;

        targets.push({
          providerName,
          modelName: modelRef,
          realModel: modelObj.realModel,
          provider,
        });
      }

      if (targets.length > 0) return targets;
    }
  }

  // 2. Direct model resolution (name or alias)
  const resolved = resolveModelAlias(config, model);
  if (resolved) {
    const provider = config.providers[resolved.providerName];
    targets.push({
      providerName: resolved.providerName,
      modelName: resolved.modelName,
      realModel: resolved.model.realModel,
      provider,
    });
    return targets;
  }

  // 3. Try provider:model format
  if (model.includes(':')) {
    const [providerRef, modelRef] = model.split(':');
    const providerName = resolveProviderName(config, providerRef) || providerRef;
    const provider = config.providers[providerName];
    if (provider && provider.models[modelRef]) {
      targets.push({
        providerName,
        modelName: modelRef,
        realModel: provider.models[modelRef].realModel,
        provider,
      });
      return targets;
    }
  }

  // 4. Try matching by realModel name (agents may send the exact upstream ID)
  for (const [pName, provider] of Object.entries(config.providers)) {
    for (const [mName, m] of Object.entries(provider.models || {})) {
      if (m.realModel === model) {
        targets.push({
          providerName: pName,
          modelName: mName,
          realModel: m.realModel,
          provider,
        });
        return targets;
      }
    }
  }

  throw new Error(`Model "${model}" not found — check model name, aliases, and groups`);
}
