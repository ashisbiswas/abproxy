/**
 * Core proxy handler — receives requests, resolves targets, and dispatches via failover.
 */

import { getConfig, getEffectiveDefaultModel } from '../config/manager.js';
import { resolveTargets } from './resolver.js';
import { executeWithFailover } from './failover.js';
import { getRequestFormat } from './adapters.js';
import { logger } from '../utils/logger.js';

/**
 * Handle an incoming proxy request (either OpenAI or Anthropic format)
 */
export async function handleProxyRequest(req, res) {
  const config = getConfig();
  const clientFormat = getRequestFormat(req.path);

  try {
    // Extract model from request body; fall back to default provider / global default
    const body = req.body;
    const defaultRef = body.model ? null : getEffectiveDefaultModel(config);
    const requestModel = body.model || defaultRef?.modelName || null;

    if (!requestModel) {
      return res.status(400).json({
        error: {
          message: 'No model specified and no default model configured',
          type: 'invalid_request_error',
        },
      });
    }

    logger.server('info', `[request] ${req.method} ${req.path} model=${requestModel} stream=${!!body.stream}`);

    // Resolve model to targets — the resolver applies the same default chain
    // (and pins to the default provider when the default comes from there)
    const targets = resolveTargets(config, body.model);

    // Execute with failover
    const result = await executeWithFailover({
      targets,
      body,
      clientFormat,
      requestModel,
      res,
      clientHeaders: req.headers,
    });

    // If streaming, response was already piped
    if (body.stream) return;

    // Send non-streaming response
    res.json(result);
  } catch (err) {
    logger.server('error', `[request] ${err.message}`);

    const statusCode = err.statusCode || 500;

    if (clientFormat === 'anthropic') {
      res.status(statusCode).json({
        type: 'error',
        error: {
          type: statusCode === 502 ? 'overloaded_error' : 'api_error',
          message: err.message,
        },
      });
    } else {
      res.status(statusCode).json({
        error: {
          message: err.message,
          type: statusCode === 502 ? 'server_error' : 'invalid_request_error',
        },
      });
    }
  }
}

/**
 * Handle /v1/models — list available models.
 *
 * Every model name AND every alias appears as a separate entry so that
 * agents that do an exact-match lookup (Claude Code, Codex, etc.) can
 * find the model by any of its configured names.
 */
export function handleListModels(req, res) {
  const config = getConfig();
  const models = [];
  const seen = new Set();

  // List all models from all providers (name + aliases)
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const [modelName, model] of Object.entries(provider.models || {})) {
      // Primary model name
      if (!seen.has(modelName)) {
        models.push({
          id: modelName,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: providerName,
          permission: [{ id: `modelperm-${modelName}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
        });
        seen.add(modelName);
      }

      // Each alias as a separate entry
      for (const alias of model.aliases || []) {
        if (!seen.has(alias)) {
          models.push({
            id: alias,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: providerName,
            permission: [{ id: `modelperm-${alias}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
          });
          seen.add(alias);
        }
      }

      // Also list the realModel name so agents that use the upstream ID directly work
      if (model.realModel && !seen.has(model.realModel)) {
        models.push({
          id: model.realModel,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: providerName,
          permission: [{ id: `modelperm-${model.realModel}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
        });
        seen.add(model.realModel);
      }
    }
  }

  // Model groups as virtual models
  for (const groupName of Object.keys(config.modelGroups || {})) {
    if (!seen.has(groupName)) {
      models.push({
        id: groupName,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'abproxy-group',
        permission: [{ id: `modelperm-${groupName}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
      });
      seen.add(groupName);
    }
  }

  res.json({
    object: 'list',
    data: models,
  });
}

/**
 * Handle /v1/models/:modelId — return a single model by ID.
 * Some agents check model existence this way.
 */
export function handleGetModel(req, res) {
  const config = getConfig();
  const modelId = req.params.modelId;

  // Search across all providers for this model ID (name, alias, or realModel)
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const [modelName, model] of Object.entries(provider.models || {})) {
      if (modelName === modelId ||
          (model.aliases || []).includes(modelId) ||
          model.realModel === modelId) {
        return res.json({
          id: modelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: providerName,
          permission: [{ id: `modelperm-${modelId}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
        });
      }
    }
  }

  // Check model groups
  if (config.modelGroups && config.modelGroups[modelId]) {
    return res.json({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'abproxy-group',
      permission: [{ id: `modelperm-${modelId}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
    });
  }

  res.status(404).json({
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      code: 'model_not_found',
    },
  });
}
