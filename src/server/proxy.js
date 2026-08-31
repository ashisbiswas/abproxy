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
 * Agents see ONLY the alias names (config.aliases) plus the literal
 * "default". No raw provider model names, no realModel IDs — the alias is
 * the one true name of a model as far as agents are concerned.
 */
export function handleListModels(req, res) {
  const config = getConfig();
  const models = [];

  const entry = (id, ownedBy) => models.push({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: ownedBy,
    permission: [{ id: `modelperm-${id}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
  });

  // The literal "default" — resolves to the default provider's default model
  entry('default', 'abproxy');

  // Every alias
  for (const [aliasName, alias] of Object.entries(config.aliases || {})) {
    entry(aliasName, alias.provider);
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

  if (modelId === 'default') {
    return res.json({
      id: 'default',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'abproxy',
      permission: [{ id: 'modelperm-default', allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
    });
  }

  const alias = (config.aliases || {})[modelId];
  if (alias) {
    return res.json({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: alias.provider,
      permission: [{ id: `modelperm-${modelId}`, allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }],
    });
  }

  res.status(404).json({
    error: {
      message: `Model '${modelId}' not found. Available: alias names from /v1/models, or 'default'.`,
      type: 'invalid_request_error',
      code: 'model_not_found',
    },
  });
}
