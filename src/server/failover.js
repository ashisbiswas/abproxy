/**
 * Failover engine — executes a resolved target; when the pinned provider's
 * account is exhausted (429 quota / 402 payment / 401 auth), automatically
 * rotates to the provider's NEXT account before giving up.
 */

import { recordSuccess, recordFailure, shouldSkip } from './health.js';
import {
  openaiToAnthropicRequest,
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicResponse,
  anthropicStreamToOpenai,
  openaiStreamToAnthropic,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  getSupportedProtocols,
} from './adapters.js';
import { getActiveApiKey, getActiveAccountName } from '../config/manager.js';
import { logger } from '../utils/logger.js';

const TIMEOUT_MS = 120000; // 2 minutes
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Errors that mean "this ACCOUNT is done" → rotate to the next account
const ACCOUNT_ROTATE_STATUS = new Set([401, 402, 403, 429]);

/**
 * Execute a request. `targets` currently holds exactly one pinned target
 * (aliases and defaults never fail over across providers); account
 * rotation happens within the target's provider.
 *
 * @param {Object} params
 * @param {Array} params.targets - Resolved targets (single entry)
 * @param {Object} params.body - Original request body from client
 * @param {string} params.clientFormat - 'openai' or 'anthropic'
 * @param {string} params.requestModel - Model name from the original request
 * @param {Object} params.res - Express response object (for streaming)
 * @returns {Object|void} - Response body for non-streaming, void for streaming
 */
export async function executeWithFailover({ targets, body, clientFormat, requestModel, res, clientHeaders = {} }) {
  const isStream = !!body.stream;
  const target = targets[0];
  const errors = [];

  if (shouldSkip(target.providerName)) {
    logger.server('info', `[failover] ${target.providerName} is cooling down — trying anyway (pinned target)`);
  }

  // ── Account rotation loop ──────────────────────────────────────
  // Try the active account; on quota/auth errors, switch to the next
  // account on the same provider and retry. One pass per account.
  const accounts = (target.provider.accounts || []).map(a => a.name);
  const triedAccounts = new Set();
  let currentAccount = null; // null = use the provider's active account

  while (true) {
    try {
      const result = await forwardRequest({
        target,
        body,
        clientFormat,
        requestModel,
        isStream,
        res,
        clientHeaders,
        accountName: currentAccount,
      });

      recordSuccess(target.providerName);
      if (isStream) return;
      return result;
    } catch (err) {
      const reason = err.statusCode
        ? `HTTP ${err.statusCode}: ${err.message}`
        : err.message;

      // Non-rotation-worthy failure → report and stop
      if (!err.statusCode || !ACCOUNT_ROTATE_STATUS.has(err.statusCode)) {
        recordFailure(target.providerName, reason);
        errors.push({ provider: target.providerName, model: target.modelName, reason });
        logger.server('warn', `[failover] ${target.providerName}:${target.modelName} failed — ${reason}`);
        throw exhaustionError(target, requestModel, errors, triedAccounts);
      }

      // Account-level failure — record it, then try the next account
      errors.push({
        provider: target.providerName,
        account: currentAccount || getActiveAccountName(target.provider),
        model: target.modelName,
        reason,
      });
      triedAccounts.add(currentAccount || getActiveAccountName(target.provider));
      logger.server('warn', `[failover] ${target.providerName} account "${currentAccount || getActiveAccountName(target.provider)}" failed — ${reason}`);

      const next = nextAccount(target.provider, triedAccounts);
      if (!next) {
        recordFailure(target.providerName, reason);
        throw exhaustionError(target, requestModel, errors, triedAccounts);
      }

      logger.server('info', `[failover] rotating ${target.providerName} to account "${next}"`);
      currentAccount = next;
    }
  }
}

/**
 * The next untried account name on the provider, or null if all tried.
 */
function nextAccount(provider, triedAccounts) {
  const accounts = (provider.accounts || []).map(a => a.name);
  return accounts.find(name => !triedAccounts.has(name)) || null;
}

function exhaustionError(target, requestModel, errors, triedAccounts) {
  const accountNote = triedAccounts.size > 0
    ? `\n  Accounts tried on ${target.providerName}: ${[...triedAccounts].join(', ')}`
    : '';
  const errorSummary = errors
    .map(e => `  • ${e.provider}${e.account ? ` (${e.account})` : ''}:${e.model} — ${e.reason}`)
    .join('\n');

  const err = new Error(
    `All accounts failed for model "${requestModel}":\n${errorSummary}${accountNote}`
  );
  err.statusCode = 502;
  return err;
}

/**
 * Forward a single request to one target provider, using the given account.
 * accountName = null means the provider's active (default) account.
 */
async function forwardRequest({ target, body, clientFormat, requestModel, isStream, res, clientHeaders = {}, accountName = null }) {
  const supported = getSupportedProtocols(target.provider);
  // Speak the client's protocol when the upstream supports it — native
  // passthrough, no lossy translation (thinking/tool_use/cache_control
  // survive intact). Otherwise translate to the provider's preferred one.
  const providerFormat = supported.includes(clientFormat) ? clientFormat : supported[0];
  const needsRequestAdapt = clientFormat !== providerFormat;

  // Account override for this attempt (rotation); falls back to active key
  const providerForAuth = accountName
    ? { ...target.provider, accounts: target.provider.accounts.map(a => ({ ...a, isDefault: a.name === accountName })) }
    : target.provider;

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

  const url = buildUpstreamUrl(target.provider, providerFormat);
  const headers = buildUpstreamHeaders(providerForAuth, isStream, clientHeaders, providerFormat);

  logger.server('info', `[proxy] → ${target.providerName}:${target.modelName}` +
    `${accountName ? ` (account "${accountName}")` : ''} (${url}) stream=${isStream}`);

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
      throw err;
    }

    // ─── Streaming response ────────────────────────────────────
    if (isStream && response.body) {
      const needsResponseAdapt = clientFormat !== providerFormat;

      res.setHeader('Content-Type', 'text/event-stream');
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

    // Same format — just replace model name with what the client asked for
    if (responseBody.model) {
      responseBody.model = requestModel;
    }

    return responseBody;
  } finally {
    clearTimeout(timeout);
    res.removeListener('close', onClose);
  }
}
