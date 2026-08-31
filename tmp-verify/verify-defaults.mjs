/**
 * Verification — default provider / per-provider default model resolution
 * and legacy-config auto-migration, in the alias-based format.
 * MUST run with USERPROFILE/HOME pointed at a sandbox home.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';

const configDir = path.join(os.homedir(), '.abproxy');
const configFile = path.join(configDir, 'config.json');

if (!/abproxy-verify/i.test(configDir)) {
  console.error(`Refusing to run: home is not a sandbox (${configDir})`);
  process.exit(1);
}

// ── Seed a LEGACY config: groups + provider aliases + model aliases ──
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({
  port: 19998,
  localApiKey: 'sk-local-defaults-test',
  defaultProvider: null,
  defaultModel: null,
  providers: {
    alpha: {
      aliases: ['a'],
      type: 'openai-compatible',
      baseURL: 'http://localhost:19777',
      autoFetch: false,
      models: { 'm1': { realModel: 'real-m1', aliases: ['one'] } },
      accounts: [{ name: 'Default', apiKey: 'sk-alpha', isDefault: true }],
    },
    beta: {
      aliases: [],
      type: 'openai-compatible',
      baseURL: 'http://localhost:19778',
      autoFetch: false,
      models: { 'm2': { realModel: 'real-m2', aliases: [] } },
      accounts: [{ name: 'Default', apiKey: 'sk-beta', isDefault: true }],
    },
  },
  modelGroups: {
    'grp': { members: ['alpha:m1', 'beta:m2'], strategy: 'failover' },
  },
}, null, 2));

const mgr = await import('../src/config/manager.js');
const { validateConfig } = await import('../src/config/schema.js');
const { resolveTargets } = await import('../src/server/resolver.js');

// ── 1. Legacy config auto-migrates on load ────────────────────────────
const config0 = mgr.getConfig();
assert.equal(config0.modelGroups, undefined, 'modelGroups must be deleted');
assert.equal(config0.providers.alpha.aliases, undefined, 'provider aliases stripped');
assert.equal(config0.providers.alpha.models.m1.aliases, undefined, 'model aliases stripped');
assert.equal(config0.aliases['alpha/m1'].model, 'm1', 'group member became alias');
assert.equal(config0.aliases['one'].model, 'm1', 'model alias became top-level alias');
assert.equal(config0.aliases['beta/m2'].model, 'm2', 'second group member became alias');
assert.ok(validateConfig(config0).valid, `migrated config must validate: ${validateConfig(config0).errors.join('; ')}`);
assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf-8')).aliases['alpha/m1'].provider, 'alpha',
  'migration must be persisted to disk');
console.log('OK 1. legacy config auto-migrated (groups + aliases → top-level aliases) and persisted');

// ── 2. No default configured → clear error ──────────────────────────
assert.equal(mgr.getEffectiveDefaultModel(config0), null);
assert.throws(() => resolveTargets(config0, null), /No default provider configured/);
assert.throws(() => resolveTargets(config0, 'default'), /No default provider configured/);
console.log('OK 2. no default → clear error');

// ── 3. Default provider pins to its default model ────────────────────
mgr.setDefaultProvider('alpha');
mgr.setProviderDefaultModel('alpha', 'm1');
const config1 = mgr.getConfig();
assert.deepEqual(mgr.getEffectiveDefaultModel(config1), { providerName: 'alpha', modelName: 'm1' });
assert.equal(mgr.formatDefaultModel(config1), 'alpha › m1');
const pinned = resolveTargets(config1, null);
assert.equal(pinned.length, 1, 'default must pin to exactly one target');
assert.deepEqual([pinned[0].providerName, pinned[0].realModel], ['alpha', 'real-m1']);
console.log('OK 3. default provider + default model → pinned single target');

// ── 4. Explicit alias still wins over the default ───────────────────
const explicit = resolveTargets(config1, 'beta/m2');
assert.deepEqual([explicit[0].providerName, explicit[0].realModel], ['beta', 'real-m2'],
  'explicit alias ignores the default provider');
console.log('OK 4. explicit alias bypasses the default provider');

// ── 5. Unknown model name falls back to default provider ─────────────
const unknown = resolveTargets(config1, 'not-a-real-model');
assert.deepEqual([unknown[0].providerName, unknown[0].modelName], ['alpha', 'm1']);
console.log('OK 5. unknown model name → default provider\'s default model');

// ── 6. Global defaultModel as fallback when provider has no default ──
mgr.setDefaultModel('m2');
mgr.setProviderDefaultModel('alpha', null);
const config2 = mgr.getConfig();
assert.deepEqual(mgr.getEffectiveDefaultModel(config2), { providerName: null, modelName: 'm2' },
  'global fallback when default provider has no default model');
const fb = resolveTargets(config2, null);
assert.deepEqual([fb[0].providerName, fb[0].modelName], ['beta', 'm2']);
console.log('OK 6. default provider without default model → global fallback');

// ── 7. Cascade cleanup keeps defaults sane ───────────────────────────
mgr.setProviderDefaultModel('beta', 'm2');
mgr.setDefaultProvider('beta');
mgr.deleteModel('beta', 'm2');
const config3 = mgr.getConfig();
assert.equal(config3.providers.beta.defaultModel, undefined, 'provider default cleared with model');
assert.equal(config3.aliases['beta/m2'], undefined, 'alias pruned with model');
mgr.deleteProvider('beta');
const config4 = mgr.getConfig();
assert.equal(config4.defaultProvider, null, 'defaultProvider cleared with provider');
assert.ok(validateConfig(config4).valid);
console.log('OK 7. delete model/provider cascades clear defaults and aliases');

// ── 8. Validation rejects bad references ────────────────────────────
const bad = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
bad.defaultProvider = 'ghost';
bad.aliases['dangling'] = { provider: 'alpha', model: 'nope' };
const badResult = validateConfig(bad);
assert.ok(!badResult.valid);
assert.ok(badResult.errors.some(e => e.includes('defaultProvider "ghost"')));
assert.ok(badResult.errors.some(e => e.includes('dangling')));
console.log('OK 8. schema validation flags dangling default/alias references');

// ── 9. Live server: no-model request hits the default provider ───────
let capturedModel = null;
const mockUpstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const parsed = JSON.parse(body);
    capturedModel = parsed.model;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: parsed.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise(r => mockUpstream.listen(19777, r));

fs.writeFileSync(configFile, JSON.stringify({
  port: 19998,
  localApiKey: 'sk-local-defaults-test',
  defaultProvider: 'alpha',
  defaultModel: 'm2',
  providers: {
    alpha: {
      type: 'openai-compatible', baseURL: 'http://localhost:19777',
      protocols: ['openai'], autoFetch: false, defaultModel: 'm1',
      models: { 'm1': { realModel: 'real-m1' } },
      accounts: [{ name: 'Default', apiKey: 'sk-alpha', isDefault: true }],
    },
    beta: {
      type: 'openai-compatible', baseURL: 'http://localhost:19778',
      protocols: ['openai'], autoFetch: false,
      models: { 'm2': { realModel: 'real-m2' } },
      accounts: [{ name: 'Default', apiKey: 'sk-beta', isDefault: true }],
    },
  },
  aliases: { 'alpha/m1': { provider: 'alpha', model: 'm1' } },
}, null, 2));

const { startServer } = await import('../src/server/index.js');
await startServer();

const resp = await fetch('http://localhost:19998/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer sk-local-defaults-test', 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }), // no model!
});
assert.equal(resp.status, 200, `expected 200 got ${resp.status}`);
const json = await resp.json();
assert.equal(capturedModel, 'real-m1', 'upstream must receive the pinned provider realModel');
console.log('OK 9. live server: no-model request served by default provider (upstream got real-m1)');

mockUpstream.close();
process.exit(0);
