/**
 * Failover engine — tries each target in order, retries on transient errors.
 */

import { recordSuccess, recordFailure, shouldSkip } from './health.js';
import {
  openaiToAnthropicRequest,
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicResponse,
  anthropicStreamToOpenai,
  openaiStreamToAnthropic,
  getRequestFormat,
  buildUpstreamHeaders,
  buildUpstreamUrl,
} from './adapters.js';
import { logger } from '../utils/logger.js';

const TIMEOUT_MS = 120000; // 2 minutes
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Execute a request with failover across targets.
 *
 * @param {Object} params
 * @param {Array} params.targets - Resolved targets from resolver
 * @param {Object} params.body - Original request body from client
 * @param {string} params.clientFormat - 'openai' or 'anthropic' (based on which endpoint client called)
 * @param {string} params.requestModel - Model name from the original request
 * @param {Object} params.res - Express response object (for streaming)
 * @returns {Object|void} - Response body for non-streaming, void for streaming (piped to res)
 */
export async function executeWithFailover({ targets, body, clientFormat, requestModel, res, clientHeaders = {} }) {
  const isStream = !!body.stream;
  const errors = [];

  for (const target of targets) {
    // Proactive skip if provider is cooling down
    if (shouldSkip(target.providerName)) {
      const reason = `Skipped (cooling down)`;
      errors.push({ provider: target.providerName, model: target.modelName, reason });
      logger.server('info', `[failover] Skipping ${target.providerName} — cooling down`);
      continue;
    }

    try {
      const result = await forwardRequest({
        target,
        body,
        clientFormat,
        requestModel,
        isStream,
        res,
        clientHeaders,
      });

      recordSuccess(target.providerName);

      if (isStream) {
        // Streaming was piped directly to res
        return;
      }

      return result;
    } catch (err) {
      const reason = err.statusCode
        ? `HTTP ${err.statusCode}: ${err.message}`
        : err.message;

      recordFailure(target.providerName, reason);
      errors.push({ provider: target.providerName, model: target.modelName, reason });
      logger.server('warn', `[failover] ${target.providerName}:${target.modelName} failed — ${reason}`);
      continue;
    }
  }

  // All targets exhausted
  const errorSummary = errors
    .map(e => `  • ${e.provider}:${e.model} — ${e.reason}`)
    .join('\n');

  const exhaustionError = new Error(
    `All providers failed for model "${requestModel}":\n${errorSummary}`
  );
  exhaustionError.statusCode = 502;
  throw exhaustionError;
}

/**
 * Forward a single request to one target provider
 */
async function forwardRequest({ target, body, clientFormat, requestModel, isStream, res, clientHeaders = {} }) {
  const providerFormat = target.provider.type === 'anthropic-native' ? 'anthropic' : 'openai';
  const needsRequestAdapt = clientFormat !== providerFormat;

  // Adapt request body if needed
  let upstreamBody;
  if (needsRequestAdapt) {
    if (clientFormat === 'openai' && providerFormat === 'anthropic') {
      upstreamBody = openaiToAnthropicRequest(body, target.realModel);
    } else {
      upstreamBody = anthropicToOpenaiRequest(body, target.realModel);
    }
  } else {
    upstreamBody = { ...body, model: target.realModel };
  }

  const url = buildUpstreamUrl(target.provider);
  const headers = buildUpstreamHeaders(target.provider, isStream, clientHeaders);

  logger.server('info', `[proxy] → ${target.providerName}:${target.modelName} (${url}) stream=${isStream}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Listen for client disconnect
  let clientDisconnected = false;
  const onClose = () => {
    clientDisconnected = true;
    controller.abort();
  };
  res.on('close', onClose);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'unknown error');
      const err = new Error(errBody.substring(0, 500));
      err.statusCode = response.status;

      // Only retry on retryable status codes
      if (RETRYABLE_STATUS.has(response.status)) {
        throw err;
      }

      // Non-retryable: return the error directly to client
      throw err;
    }

    // ─── Streaming response ────────────────────────────────────
    if (isStream && response.body) {
      const needsResponseAdapt = clientFormat !== providerFormat;

      // Set SSE headers
      if (clientFormat === 'anthropic') {
        res.setHeader('Content-Type', 'text/event-stream');
      } else {
        res.setHeader('Content-Type', 'text/event-stream');
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const reader = response.body.getReader();

      if (needsResponseAdapt) {
        // Pipe through transform stream
        let transformStream;
        if (providerFormat === 'anthropic' && clientFormat === 'openai') {
          transformStream = anthropicStreamToOpenai(requestModel);
        } else {
          transformStream = openaiStreamToAnthropic(requestModel);
        }

        const writer = transformStream.writable.getWriter();
        const transformReader = transformStream.readable.getReader();

        // Read from transform output and write to client
        const pipeToClient = async () => {
          while (true) {
            const { done, value } = await transformReader.read();
            if (done) break;
            if (clientDisconnected) break;
            res.write(value);
          }
        };

        // Feed upstream data into transform input
        const feedTransform = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              await writer.close();
              break;
            }
            if (clientDisconnected) {
              await writer.abort();
              break;
            }
            await writer.write(value);
          }
        };

        await Promise.all([feedTransform(), pipeToClient()]);
      } else {
        // Direct passthrough — no adaptation needed
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientDisconnected) break;
          res.write(value);
        }
      }

      res.end();
      return;
    }

    // ─── Non-streaming response ────────────────────────────────
    const responseBody = await response.json();
    const needsResponseAdapt = clientFormat !== providerFormat;

    if (needsResponseAdapt) {
      if (providerFormat === 'anthropic' && clientFormat === 'openai') {
        return anthropicToOpenaiResponse(responseBody, requestModel);
      } else {
        return openaiToAnthropicResponse(responseBody, requestModel);
      }
    }

    // Same format — just replace model name
    if (clientFormat === 'openai' && responseBody.model) {
      responseBody.model = requestModel;
    } else if (clientFormat === 'anthropic' && responseBody.model) {
      responseBody.model = requestModel;
    }

    return responseBody;
  } finally {
    clearTimeout(timeout);
    res.removeListener('close', onClose);
  }
}
