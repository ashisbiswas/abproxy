/**
 * OpenAI Responses API adapter (POST /v1/responses).
 *
 * Codex CLI only speaks the Responses protocol (wire_api = "responses" —
 * "chat" was removed in current Codex). abproxy's engine is built around
 * OpenAI chat / Anthropic messages, so this module translates:
 *
 *   Responses request  → OpenAI chat request      (any upstream)
 *   Responses request  → Anthropic request        (via chat intermediate)
 *   OpenAI chat resp.  → Responses response       (non-stream + SSE)
 *   Anthropic resp.    → Responses response       (via chat intermediate)
 *
 * Tool calls (Codex's agent loop) round-trip: function_call items keep the
 * upstream call_id, so function_call_output items map straight back to
 * chat "tool" messages on the next turn.
 */

import {
  openaiToAnthropicRequest,
  anthropicToOpenaiResponse,
  anthropicStreamToOpenai,
} from './adapters.js';

// ─── Small helpers ───────────────────────────────────────────────────

function randId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Wire N TransformStreams in series and expose the pair
 * { writable: first.writable, readable: last.readable }.
 */
function chainTransforms(...streams) {
  for (let i = 0; i + 1 < streams.length; i++) {
    streams[i].readable.pipeTo(streams[i + 1].writable).catch(() => {});
  }
  return { writable: streams[0].writable, readable: streams[streams.length - 1].readable };
}

/**
 * Flatten a Responses message content value (string or part array) into
 * chat-completions content: a plain string when all parts are text,
 * otherwise an array of chat content parts (text / image_url).
 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : String(content);

  const parts = [];
  let allText = true;
  for (const part of content) {
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'summary_text' || part?.type === 'refusal') {
      parts.push({ type: 'text', text: part.text || '' });
    } else if (part?.type === 'input_image') {
      allText = false;
      parts.push({ type: 'image_url', image_url: { url: part.image_url || part.url || '' } });
    } else if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
    } else {
      allText = false;
      parts.push({ type: 'text', text: JSON.stringify(part) });
    }
  }
  if (allText) return parts.map(p => p.text).join('');
  return parts;
}

/**
 * Flatten a function_call_output.output value (string or part array) to a
 * string — chat "tool" message content.
 */
function flattenOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map(p => (typeof p === 'string' ? p : p?.text ?? JSON.stringify(p)))
      .join('');
  }
  if (output && typeof output === 'object') return JSON.stringify(output);
  return output === undefined || output === null ? '' : String(output);
}

// ─── Request: Responses → OpenAI chat ────────────────────────────────

export function responsesToOpenaiRequest(body, realModel) {
  const messages = [];

  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : (body.input || []);

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'message') {
      const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
      messages.push({ role, content: flattenContent(item.content) });
    } else if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || randId('call_'),
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' },
        }],
      });
    } else if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: flattenOutput(item.output),
      });
    }
    // 'reasoning' and unknown item types have no chat equivalent — skipped
  }

  const result = { model: realModel, messages };

  if (body.max_output_tokens) result.max_completion_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = body.parallel_tool_calls;

  const tools = (body.tools || [])
    .filter(t => t && t.type === 'function' && t.name)
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
  if (tools.length > 0) result.tools = tools;

  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') {
      result.tool_choice = body.tool_choice; // 'auto' | 'none' | 'required'
    } else if (body.tool_choice?.type === 'function' && body.tool_choice.name) {
      result.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  if (body.stream) {
    result.stream = true;
    result.stream_options = { include_usage: true };
  }

  return result;
}

/** Responses → Anthropic (chat intermediate), for anthropic-native upstreams. */
export function responsesToAnthropicRequest(body, realModel) {
  const chat = responsesToOpenaiRequest(body, realModel);
  delete chat.stream_options;
  return openaiToAnthropicRequest(chat, realModel);
}

// ─── Response: OpenAI chat → Responses (non-stream) ──────────────────

function mapUsage(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
  };
}

function baseResponse(id, model, status, output, usage) {
  const resp = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    tool_choice: 'auto',
    tools: [],
    parallel_tool_calls: false,
    metadata: {},
    error: null,
    incomplete_details: null,
  };
  if (usage) resp.usage = usage;
  return resp;
}

export function openaiToResponsesResponse(openaiResp, requestModel) {
  const choice = openaiResp?.choices?.[0];
  const message = choice?.message;
  const output = [];

  if (message?.content) {
    output.push({
      type: 'message',
      id: randId('msg_'),
      object: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }

  for (const tc of message?.tool_calls || []) {
    output.push({
      type: 'function_call',
      id: randId('fc_'),
      call_id: tc.id || randId('call_'),
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '{}',
      status: 'completed',
    });
  }

  const finish = choice?.finish_reason;
  return baseResponse(
    openaiResp?.id || randId('resp_'),
    requestModel,
    finish === 'length' ? 'incomplete' : 'completed',
    output,
    mapUsage(openaiResp?.usage)
  );
}

/** Anthropic → Responses (chat intermediate). */
export function anthropicToResponsesResponse(anthropicResp, requestModel) {
  return openaiToResponsesResponse(anthropicToOpenaiResponse(anthropicResp, requestModel), requestModel);
}

// ─── Response: OpenAI chat SSE → Responses SSE ───────────────────────

/**
 * Transform an OpenAI chat SSE stream into Responses API SSE events.
 * Emits: response.created, output_item.added / content_part.added /
 * output_text.delta(+done), function_call_arguments.delta(+done),
 * output_item.done, response.completed.
 */
export function openaiStreamToResponses(requestModel) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const respId = randId('resp_');
  let created = false;

  // Message item being streamed (only one text item per chat response)
  let message = null; // { id, outputIndex, text }

  // Tool calls by chat chunk index: { id, name, arguments, outputIndex, itemId }
  const toolCalls = new Map();
  let nextOutputIndex = 0;

  const finalItems = [];
  let usage = null;

  function responseEnvelope(status) {
    return baseResponse(respId, requestModel, status, status === 'completed' ? finalItems : [], usage ? mapUsage(usage) : undefined);
  }

  function send(controller, type, payload) {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));
  }

  function ensureCreated(controller) {
    if (created) return;
    created = true;
    send(controller, 'response.created', { response: responseEnvelope('in_progress') });
  }

  function openMessage(controller) {
    if (message) return;
    ensureCreated(controller);
    message = { id: randId('msg_'), outputIndex: nextOutputIndex++, text: '' };
    send(controller, 'response.output_item.added', {
      output_index: message.outputIndex,
      item: { type: 'message', id: message.id, object: 'message', role: 'assistant', status: 'in_progress', content: [] },
    });
    send(controller, 'response.content_part.added', {
      item_id: message.id,
      output_index: message.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  function closeMessage(controller) {
    if (!message) return;
    const part = { type: 'output_text', text: message.text, annotations: [] };
    send(controller, 'response.output_text.done', {
      item_id: message.id,
      output_index: message.outputIndex,
      content_index: 0,
      text: message.text,
    });
    send(controller, 'response.content_part.done', {
      item_id: message.id,
      output_index: message.outputIndex,
      content_index: 0,
      part,
    });
    const item = {
      type: 'message',
      id: message.id,
      object: 'message',
      role: 'assistant',
      status: 'completed',
      content: [part],
    };
    send(controller, 'response.output_item.done', { output_index: message.outputIndex, item });
    finalItems.push(item);
    message = null;
  }

  function openToolCall(controller, index, id, name) {
    closeMessage(controller);
    const entry = {
      callId: id || randId('call_'),
      name: name || '',
      arguments: '',
      outputIndex: nextOutputIndex++,
      itemId: randId('fc_'),
    };
    toolCalls.set(index, entry);
    send(controller, 'response.output_item.added', {
      output_index: entry.outputIndex,
      item: {
        type: 'function_call',
        id: entry.itemId,
        call_id: entry.callId,
        name: entry.name,
        arguments: '',
        status: 'in_progress',
      },
    });
  }

  function closeToolCall(controller, entry) {
    send(controller, 'response.function_call_arguments.done', {
      item_id: entry.itemId,
      output_index: entry.outputIndex,
      arguments: entry.arguments || '{}',
    });
    const item = {
      type: 'function_call',
      id: entry.itemId,
      call_id: entry.callId,
      name: entry.name,
      arguments: entry.arguments || '{}',
      status: 'completed',
    };
    send(controller, 'response.output_item.done', { output_index: entry.outputIndex, item });
    finalItems.push(item);
  }

  function complete(controller) {
    closeMessage(controller);
    for (const entry of toolCalls.values()) closeToolCall(controller, entry);
    toolCalls.clear();
    send(controller, 'response.completed', { response: responseEnvelope('completed') });
  }

  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue; // ignore event:/comments
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          complete(controller);
          continue;
        }

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.usage) usage = event.usage;

        const choice = event.choices?.[0];
        if (!choice) continue;
        ensureCreated(controller);

        const delta = choice.delta || {};

        if (typeof delta.content === 'string' && delta.content.length > 0) {
          openMessage(controller);
          message.text += delta.content;
          send(controller, 'response.output_text.delta', {
            item_id: message.id,
            output_index: message.outputIndex,
            content_index: 0,
            delta: delta.content,
          });
        }

        for (const tc of delta.tool_calls || []) {
          const index = tc.index ?? 0;
          let entry = toolCalls.get(index);
          if (!entry) {
            openToolCall(controller, index, tc.id, tc.function?.name);
            entry = toolCalls.get(index);
          }
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
          if (tc.function?.arguments) {
            entry.arguments += tc.function.arguments;
            send(controller, 'response.function_call_arguments.delta', {
              item_id: entry.itemId,
              output_index: entry.outputIndex,
              delta: tc.function.arguments,
            });
          }
        }
      }
    },
    flush(controller) {
      // Stream ended without [DONE] — still emit response.completed
      if (created || message || toolCalls.size > 0) {
        ensureCreated(controller);
        complete(controller);
      }
    },
  });
}

/** Anthropic SSE → Responses SSE (chat intermediate). */
export function anthropicStreamToResponses(requestModel) {
  return chainTransforms(
    anthropicStreamToOpenai(requestModel),
    openaiStreamToResponses(requestModel)
  );
}
