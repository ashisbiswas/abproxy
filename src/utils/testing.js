import chalk from 'chalk';
import { getConfig, resolveProviderName, resolveModelAlias } from '../config/manager.js';
import { buildUpstreamUrl, buildUpstreamHeaders } from '../server/adapters.js';

/**
 * Test a provider by making a minimal completion request
 * Returns { success, latencyMs, error, provider, model }
 */
export async function testProvider(providerName) {
  const config = getConfig();
  const resolvedName = resolveProviderName(config, providerName);
  if (!resolvedName) {
    return { success: false, error: `Provider "${providerName}" not found` };
  }

  const provider = config.providers[resolvedName];
  const models = Object.entries(provider.models || {});
  if (models.length === 0) {
    return { success: false, error: `Provider "${resolvedName}" has no models configured` };
  }

  const [modelName, model] = models[0];
  return testModel(`${resolvedName}:${modelName}`);
}

/**
 * Test a specific model by making a minimal completion request
 * Accepts "provider:model" format or just a model name/alias
 */
export async function testModel(modelRef) {
  const config = getConfig();
  let providerName, modelName, provider, model;

  if (modelRef.includes(':')) {
    // provider:model format
    const [pRef, mRef] = modelRef.split(':');
    providerName = resolveProviderName(config, pRef);
    if (!providerName) {
      return { success: false, error: `Provider "${pRef}" not found` };
    }
    provider = config.providers[providerName];
    model = provider.models[mRef];
    modelName = mRef;
    if (!model) {
      return { success: false, error: `Model "${mRef}" not found on provider "${providerName}"` };
    }
  } else {
    // Resolve by model name/alias
    const resolved = resolveModelAlias(config, modelRef);
    if (!resolved) {
      return { success: false, error: `Model "${modelRef}" not found` };
    }
    providerName = resolved.providerName;
    modelName = resolved.modelName;
    model = resolved.model;
    provider = config.providers[providerName];
  }

  const startTime = Date.now();
  const url = buildUpstreamUrl(provider);
  const headers = buildUpstreamHeaders(provider, false);

  // Build the appropriate request body based on provider type
  const body = provider.type === 'anthropic-native'
    ? {
        model: model.realModel,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      }
    : {
        model: model.realModel,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        latencyMs,
        error: `HTTP ${response.status}: ${body.substring(0, 200)}`,
        provider: providerName,
        model: modelName,
      };
    }

    const body = await response.json();
    return {
      success: true,
      latencyMs,
      provider: providerName,
      model: modelName,
      realModel: model.realModel,
      response: body,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      success: false,
      latencyMs,
      error: err.message,
      provider: providerName,
      model: modelName,
    };
  }
}

/**
 * Format a test result for console output
 */
export function formatTestResult(result) {
  const lines = [];
  if (result.success) {
    lines.push(chalk.green('  ✔ Test passed'));
    lines.push(chalk.gray(`    Provider: ${result.provider}`));
    lines.push(chalk.gray(`    Model: ${result.model} → ${result.realModel}`));
    lines.push(chalk.gray(`    Latency: ${result.latencyMs}ms`));
  } else {
    lines.push(chalk.red('  ✖ Test failed'));
    if (result.provider) lines.push(chalk.gray(`    Provider: ${result.provider}`));
    if (result.model) lines.push(chalk.gray(`    Model: ${result.model}`));
    if (result.latencyMs) lines.push(chalk.gray(`    Latency: ${result.latencyMs}ms`));
    lines.push(chalk.red(`    Error: ${result.error}`));
  }
  return lines.join('\n');
}
