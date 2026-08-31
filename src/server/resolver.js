/**
 * Request resolution — maps the model name an agent sends to a target.
 *
 * Agents only see alias names (config.aliases) plus the literal "default"
 * at /v1/models. Resolution order:
 *
 *   1. "default" (literal)      → default provider's default model, pinned
 *   2. alias name               → its provider + model, pinned
 *   3. "Provider/Model" form   → exact provider name + its model name
 *   4. exact provider+model ref (internal "Provider:Model") → that target
 *   5. anything else (incl. no model) → default provider's default model,
 *      so a misconfigured agent still gets a working model
 *
 * Every alias/default hit is PINNED to one provider — no cross-provider
 * failover (accounts on the pinned provider rotate instead; see failover.js).
 */

import { resolveAlias, resolveProviderName, resolveModelAlias, getEffectiveDefaultModel } from '../config/manager.js';

/**
 * Resolve a model identifier from a request to a single target.
 * Returns { providerName, modelName, realModel, provider } or throws.
 */
export function resolveTargets(config, requestModel) {
  // ── 1. The literal "default" ────────────────────────────────────
  if (requestModel === 'default') {
    return defaultTarget(config, 'default');
  }

  if (requestModel) {
    // ── 2. Alias name (what /v1/models shows) ────────────────────
    const alias = resolveAlias(config, requestModel);
    if (alias) {
      return [{
        providerName: alias.providerName,
        modelName: alias.modelName,
        realModel: alias.model.realModel,
        provider: config.providers[alias.providerName],
      }];
    }

    // ── 3. "Provider/Model" form ─────────────────────────────────
    if (requestModel.includes('/')) {
      const [pRef, mName] = requestModel.split('/');
      const pName = resolveProviderName(config, pRef);
      const provider = pName ? config.providers[pName] : null;
      const model = provider?.models?.[mName];
      if (model) {
        return [{
          providerName: pName,
          modelName: mName,
          realModel: model.realModel,
          provider,
        }];
      }
    }

    // ── 4. Internal "Provider:Model" ref ─────────────────────────
    if (requestModel.includes(':')) {
      const [pRef, mName] = requestModel.split(':');
      const pName = resolveProviderName(config, pRef);
      const provider = pName ? config.providers[pName] : null;
      const model = provider?.models?.[mName];
      if (model) {
        return [{
          providerName: pName,
          modelName: mName,
          realModel: model.realModel,
          provider,
        }];
      }
    }
  }

  // ── 5. No model / unknown model name → default provider's default model ──
  // An agent configured with a stale or upstream-real model name still
  // gets served by the default provider instead of erroring.
  const label = requestModel || '(none)';
  const target = defaultTarget(config, label);
  if (requestModel) {
    // Only reachable when a model was given but matched nothing above
    return target;
  }
  return target;
}

/**
 * The default provider's default model as a single pinned target.
 * If no default provider is set (or it has no default model), the global
 * defaultModel name is used — resolved to whichever provider has it.
 */
function defaultTarget(config, requestLabel) {
  const def = getEffectiveDefaultModel(config);
  if (!def) {
    throw new Error(
      `No default provider configured. Set one with: abproxy provider set-default <provider> ` +
      `(and give it a default model with: abproxy provider default-model <provider> <model>)`
    );
  }

  // Default provider path — pinned to that provider
  if (def.providerName) {
    const provider = config.providers[def.providerName];
    const model = provider?.models?.[def.modelName];
    if (!model) {
      throw new Error(`Default model "${def.modelName}" not found on default provider "${def.providerName}"`);
    }
    return [{
      providerName: def.providerName,
      modelName: def.modelName,
      realModel: model.realModel,
      provider,
      viaDefault: true,
      requestedName: requestLabel,
    }];
  }

  // Global defaultModel fallback — resolve the model name to a provider
  const resolved = resolveModelAlias(config, def.modelName);
  if (!resolved) {
    throw new Error(
      `Global default model "${def.modelName}" not found on any provider. ` +
      `Set a default provider instead: abproxy provider set-default <provider>`
    );
  }
  return [{
    providerName: resolved.providerName,
    modelName: resolved.modelName,
    realModel: resolved.model.realModel,
    provider: config.providers[resolved.providerName],
    viaDefault: true,
    requestedName: requestLabel,
  }];
}
