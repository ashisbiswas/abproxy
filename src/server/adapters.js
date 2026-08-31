/**
 * Protocol adapters: translate between OpenAI and Anthropic request/response formats.
 *
 * Two directions:
 * - Client sends OpenAI format → upstream is Anthropic → adapt request + adapt response back
 * - Client sends Anthropic format → upstream is OpenAI → adapt request + adapt response back
 */

import { getActiveApiKey } from '../config/manager.js';

// ─── Request Adaptation ─────────────────────────────────────────────

/**
 * Convert an OpenAI chat completion request body to Anthropic /v1/messages body
 */
export function openaiToAnthropicRequest(body, realModel) {
  const messages = (body.messages || []).slice();
  let system = undefined;

  // Extract system message
  const systemIdx = messages.findIndex(m => m.role === 'system');
  if (systemIdx !== -1) {
    system = messages[systemIdx].content;
    messages.splice(systemIdx, 1);
  }

  // Map messages
  const anthropicMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : m.content,
  }));

  const result = {
    model: realModel,
    messages: anthropicMessages,
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
  };

  if (system) result.system = system;
  if (body.stream) result.stream = true;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  return result;
}

/**
 * Convert an Anthropic /v1/messages request body to OpenAI chat completion body
 */
export function anthropicToOpenaiRequest(body, realModel) {
  const messages = [];

  // System message
  if (body.system) {
    messages.push({ role: 'system', content: body.system });
  }

  // Map messages
  for (const m of body.messages || []) {
    messages.push({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    });
  }

  const result = {
    model: realModel,
    messages,
  };

  if (body.max_tokens) result.max_tokens = body.max_tokens;
  if (body.stream) result.stream = true;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences) result.stop = body.stop_sequences;

  return result;
}

// ─── Response Adaptation ────────────────────────────────────────────

/**
 * Convert an Anthropic non-streaming response to OpenAI chat completion format
 */
export function anthropicToOpenaiResponse(anthropicResp, requestModel) {
  const content = (anthropicResp.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');

  return {
    id: anthropicResp.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: mapStopReason(anthropicResp.stop_reason),
      },
    ],
    usage: anthropicResp.usage
      ? {
          prompt_tokens: anthropicResp.usage.input_tokens || 0,
          completion_tokens: anthropicResp.usage.output_tokens || 0,
          total_tokens: (anthropicResp.usage.input_tokens || 0) + (anthropicResp.usage.output_tokens || 0),
        }
      : undefined,
  };
}

/**
 * Convert an OpenAI non-streaming response to Anthropic /v1/messages format
 */
export function openaiToAnthropicResponse(openaiResp, requestModel) {
  const choice = openaiResp.choices?.[0];
  const content = choice?.message?.content || '';

  return {
    id: openaiResp.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content: [{ type: 'text', text: content }],
    stop_reason: mapFinishReason(choice?.finish_reason),
    usage: openaiResp.usage
      ? {
          input_tokens: openaiResp.usage.prompt_tokens || 0,
          output_tokens: openaiResp.usage.completion_tokens || 0,
        }
      : undefined,
  };
}

// ─── Streaming Adaptation ───────────────────────────────────────────

/**
 * Transform an Anthropic SSE stream into OpenAI SSE stream format.
 * Returns a TransformStream.
 */
export function anthropicStreamToOpenai(requestModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            continue;
          }

          try {
            const event = JSON.parse(data);

            if (event.type === 'content_block_delta' && event.delta?.text) {
              const openaiChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: requestModel,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta.text },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`));
            } else if (event.type === 'message_stop') {
              const stopChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: requestModel,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            }
            // Pass through other event types silently
          } catch {
            // Malformed JSON — skip
          }
        } else if (line.startsWith('event: ')) {
          // Anthropic event type lines — skip (we read them from the data)
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        // Handle any remaining buffered data
      }
    },
  });
}

/**
 * Transform an OpenAI SSE stream into Anthropic SSE stream format.
 * Returns a TransformStream.
 */
export function openaiStreamToAnthropic(requestModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            controller.enqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`));
            continue;
          }

          try {
            const event = JSON.parse(data);
            const choice = event.choices?.[0];
            if (!choice) continue;

            if (!started) {
              // Send message_start
              controller.enqueue(encoder.encode(
                `event: message_start\ndata: ${JSON.stringify({
                  type: 'message_start',
                  message: {
                    id: event.id || `msg_${Date.now()}`,
                    type: 'message',
                    role: 'assistant',
                    model: requestModel,
                    content: [],
                  },
                })}\n\n`
              ));
              controller.enqueue(encoder.encode(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
                })}\n\n`
              ));
              started = true;
            }

            if (choice.delta?.content) {
              controller.enqueue(encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: choice.delta.content },
                })}\n\n`
              ));
            }

            if (choice.finish_reason) {
              controller.enqueue(encoder.encode(
                `event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: 0,
                })}\n\n`
              ));
            }
          } catch {
            // Malformed JSON — skip
          }
        }
      }
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function mapStopReason(anthropicReason) {
  switch (anthropicReason) {
    case 'end_turn': return 'stop';
    case 'max_tokens': return 'length';
    case 'stop_sequence': return 'stop';
    default: return 'stop';
  }
}

function mapFinishReason(openaiReason) {
  switch (openaiReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}

/**
 * Determine the request format based on which endpoint the client called
 */
export function getRequestFormat(requestPath) {
  if (requestPath.includes('/v1/messages')) return 'anthropic';
  if (requestPath.includes('/v1/chat/completions')) return 'openai';
  return 'openai'; // default
}

/**
 * Build upstream request headers
 */
export function buildUpstreamHeaders(provider, isStream, clientHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };

  // Multi-account: use the provider's active (default) account key
  const apiKey = getActiveApiKey(provider);

  if (provider.type === 'anthropic-native') {
    headers['x-api-key'] = apiKey;
    // Use client's anthropic-version if provided, otherwise default
    headers['anthropic-version'] = clientHeaders['anthropic-version'] || '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Include any custom headers from provider config
  if (provider.headers && typeof provider.headers === 'object') {
    Object.assign(headers, provider.headers);
  }

  return headers;
}

/**
 * Build upstream URL — handles different provider URL patterns:
 *
 *   baseURL = "https://seekai.cc/v1"       → .../v1/chat/completions or .../v1/messages
 *   baseURL = "https://seekai.cc"           → .../v1/chat/completions or .../v1/messages
 *   baseURL = "https://api.openai.com/v1"   → .../v1/chat/completions
 *   baseURL = "https://provider.com/v1/"    → .../v1/chat/completions
 */
export function buildUpstreamUrl(provider) {
  const base = provider.baseURL.replace(/\/+$/, '');

  if (provider.type === 'anthropic-native') {
    // For Anthropic-native: need /v1/messages
    if (/\/v1$/i.test(base)) {
      return `${base}/messages`;
    }
    return `${base}/v1/messages`;
  } else {
    // For OpenAI-compatible: need /v1/chat/completions or /chat/completions
    if (/\/v1$/i.test(base)) {
      return `${base}/chat/completions`;
    }
    // If base already contains /v1/, append just the path
    if (/\/v1\//i.test(base)) {
      return `${base.replace(/\/v1\/.*$/, '/v1')}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  }
}

