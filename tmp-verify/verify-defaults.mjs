/**
 * Temporary verification script — exercises default provider / per-provider
 * default model resolution. MUST run with USERPROFILE/HOME pointed at a
 * sandbox home so the real ~/.abproxy/config.json is never touched.
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

// ── Seed config: two providers, one failover group ───────────────────
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
      models: { 'm1': { realModel: 'real-m1', aliases: [] } },
      accounts: [{ name: 'Default', apiKey: 'sk-alpha', isDefault: true }],
    },
    beta: {
      aliases: ['b'],
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

// ── 1. No default configured ─────────────────────────────────────────
const config0 = mgr.getConfig();
assert.equal(mgr.getEffectiveDefaultModel(config0), null);
assert.equal(mgr.formatDefaultModel(config0), null);
assert.throws(() => resolveTargets(config0, null), /No model specified/);
console.log('OK 1. no default → request without model errors cleanly');

// ── 2. Global default resolves through group chain (failover intact) ─
mgr.setDefaultModel('grp');
const config1 = mgr.getConfig();
assert.deepEqual(mgr.getEffectiveDefaultModel(config1), { providerName: null, modelName: 'grp' });
const groupTargets = resolveTargets(config1, null);
assert.equal(groupTargets.length, 2, 'global default keeps group failover');
assert.deepEqual(groupTargets.map(t => t.providerName), ['alpha', 'beta']);
console.log('OK 2. global default resolves through the group (2 failover targets)');

// ── 3. Default provider pins to that provider only ───────────────────
mgr.setDefaultProvider('alpha');
mgr.setProviderDefaultModel('alpha', 'm1');
const config2 = mgr.getConfig();
assert.deepEqual(mgr.getEffectiveDefaultModel(config2), { providerName: 'alpha', modelName: 'm1' });
assert.equal(mgr.formatDefaultModel(config2), 'alpha › m1');
const pinned = resolveTargets(config2, null);
assert.equal(pinned.length, 1, 'default provider must pin to exactly one target');
assert.equal(pinned[0].providerName, 'alpha');
assert.equal(pinned[0].realModel, 'real-m1');
console.log('OK 3. default provider + its default model → pinned single target');

// ── 4. Explicit model still wins over defaults ───────────────────────
const explicit = resolveTargets(config2, 'm2');
assert.equal(explicit[0].providerName, 'beta', 'explicit model ignores the default provider');
console.log('OK 4. explicit model bypasses the default provider');

// ── 5. Default provider without a default model falls back to global ─
mgr.setProviderDefaultModel('beta', 'm2');
mgr.setDefaultProvider('beta');
mgr.setProviderDefaultModel('beta', null); // clear beta's default model
const config3 = mgr.getConfig();
assert.equal(mgr.getEffectiveDefaultModel(config3).modelName, 'grp',
  'global fallback when default provider has no default model');
const fbTargets = resolveTargets(config3, null);
assert.equal(fbTargets.length, 2, 'global fallback keeps group failover');
console.log('OK 5. default provider without default model → global fallback (group intact)');

// ── 6. Cascade cleanup ───────────────────────────────────────────────
mgr.setProviderDefaultModel('beta', 'm2');
mgr.deleteModel('beta', 'm2');
const config4 = mgr.getConfig();
assert.equal(config4.providers.beta.defaultModel, undefined,
  'deleting a model must clear the provider default');
mgr.setDefaultProvider('beta');
mgr.deleteProvider('beta');
const config5 = mgr.getConfig();
assert.equal(config5.defaultProvider, null,
  'deleting the default provider must clear defaultProvider');
assert.ok(validateConfig(config5).valid, `config must stay valid: ${validateConfig(config5).errors.join('; ')}`);
console.log('OK 6. delete model/provider cascades clear the defaults');

// ── 7. Validation rejects bad references ─────────────────────────────
const bad = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
bad.defaultProvider = 'ghost';
bad.providers.alpha.defaultModel = 'nope';
const badResult = validateConfig(bad);
assert.ok(!badResult.valid);
assert.ok(badResult.errors.some(e => e.includes('defaultProvider "ghost"')));
assert.ok(badResult.errors.some(e => e.includes('defaultModel "nope"')));
console.log('OK 7. schema validation flags dangling default references');

// ── 8. Live server test: no-model request hits the default provider ──
// Rebuild config pointing alpha at a mock upstream that echoes the model it got.
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
  defaultModel: 'grp',
  providers: {
    alpha: {
      aliases: [], type: 'openai-compatible', baseURL: 'http://localhost:19777', autoFetch: false,
      models: { 'm1': { realModel: 'real-m1', aliases: [] }, 'm1': { realModel: 'real-m1', aliases: [] } },
      defaultModel: 'm1',
      accounts: [{ name: 'Default', apiKey: 'sk-alpha', isDefault: true }],
    },
    beta: {
      aliases: [], type: 'openai-compatible', baseURL: 'http://localhost:19779', autoFetch: false,
      models: { 'm2': { realModel: 'real-m2', aliases: [] } },
      accounts: [{ name: 'Default', apiKey: 'sk-beta', isDefault: true }],
    },
  },
  modelGroups: { 'grp': { members: ['alpha:m1', 'beta:m2'], strategy: 'failover' } },
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
assert.equal(json.model, 'm1', 'response model should be the request-facing default name');
assert.equal(capturedModel, 'real-m1', 'upstream must receive the pinned provider realModel');

// Sanity: explicit group model still works alongside the default provider
const resp2 = await fetch('http://localhost:19998/v1/chat/completions', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer sk-local-defaults-test', 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal(resp2.status, 200);
console.log('OK 8. live server: no-model request served by default provider (upstream got real-m1)');

mockUpstream.close();
process.exit(0);
