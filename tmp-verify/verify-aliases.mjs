/**
 * Verification — alias-based model exposure + account rotation.
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

// ── Mock upstream: fails with 429 for exhausted accounts ─────────────
const seen = [];
const mockUpstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const key = req.headers['x-api-key'] || req.headers['authorization'];
    seen.push({ key, model: body ? JSON.parse(body).model : null });
    // Account A's key is "exhausted" → 429; Account B works
    if (String(key).includes('key-a')) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'quota exhausted' } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: JSON.parse(body).model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});
await new Promise(r => mockUpstream.listen(19795, r));

// ── Seed config in the NEW format ────────────────────────────────────
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({
  port: 19996,
  localApiKey: 'sk-local-alias-test',
  defaultProvider: 'prov1',
  defaultModel: null,
  providers: {
    prov1: {
      type: 'openai-compatible', baseURL: 'http://localhost:19795',
      protocols: ['openai'], autoFetch: false, defaultModel: 'm1',
      models: { 'm1': { realModel: 'real-m1' }, 'm2': { realModel: 'real-m2' } },
      accounts: [
        { name: 'A', apiKey: 'sk-key-a', isDefault: true },
        { name: 'B', apiKey: 'sk-key-b', isDefault: false },
      ],
    },
    prov2: {
      type: 'openai-compatible', baseURL: 'http://localhost:19795',
      protocols: ['openai'], autoFetch: false,
      models: { 'm1': { realModel: 'real-m1' } },
      accounts: [{ name: 'A', apiKey: 'sk-key-a', isDefault: true }],
    },
  },
  aliases: {
    'prov1/m1': { provider: 'prov1', model: 'm1' },
    'short': { provider: 'prov1', model: 'm2' },
  },
}, null, 2));

const mgr = await import('../src/config/manager.js');
const { validateConfig } = await import('../src/config/schema.js');
const { resolveTargets } = await import('../src/server/resolver.js');

// ── 1. Config validates in new format ────────────────────────────────
const config = mgr.getConfig();
assert.ok(validateConfig(config).valid, `must validate: ${validateConfig(config).errors.join('; ')}`);
console.log('OK 1. new-format config validates');

// ── 2. Alias CRUD ─────────────────────────────────────────────────────
assert.throws(() => mgr.addAlias('x/y', { provider: 'ghost', model: 'm1' }), /not found/);
assert.throws(() => mgr.addAlias('x/y', { provider: 'prov1', model: 'nope' }), /not found/);
assert.throws(() => mgr.addAlias('prov1/m1', { provider: 'prov1', model: 'm1' }), /already exists/);
mgr.addAlias('prov2/m1', { provider: 'prov2', model: 'm1' });
assert.equal(mgr.listAliases()['prov2/m1'].provider, 'prov2');
mgr.editAlias('short', { name: 'brief', provider: 'prov1', model: 'm2' });
assert.ok(mgr.listAliases()['brief'] && !mgr.listAliases()['short'], 'edit must rename');
console.log('OK 2. alias CRUD + duplicate/dangling guards');

// ── 3. Resolver: alias / default / unknown / none ─────────────────────
// (config object was captured before test 2's mutations — reload it)
Object.assign(config, mgr.getConfig());
let t = resolveTargets(config, 'prov1/m1');
assert.equal(t.length, 1);
assert.deepEqual([t[0].providerName, t[0].modelName, t[0].realModel], ['prov1', 'm1', 'real-m1']);

t = resolveTargets(config, 'brief');
assert.deepEqual([t[0].providerName, t[0].modelName], ['prov1', 'm2']);

t = resolveTargets(config, 'default');
assert.deepEqual([t[0].providerName, t[0].modelName], ['prov1', 'm1']);

t = resolveTargets(config, null);
assert.deepEqual([t[0].providerName, t[0].modelName], ['prov1', 'm1'], 'no model → default');

t = resolveTargets(config, 'totally-unknown-name');
assert.deepEqual([t[0].providerName, t[0].modelName], ['prov1', 'm1'], 'unknown → default provider');

t = resolveTargets(config, 'prov2/m1');
assert.equal(t[0].providerName, 'prov2');
console.log('OK 3. resolver: alias, Provider/Model, default, unknown→default, none→default');

// ── 4. No default configured → clear error ───────────────────────────
const noDefault = JSON.parse(JSON.stringify(config));
noDefault.defaultProvider = null;
noDefault.defaultModel = null;
assert.throws(() => resolveTargets(noDefault, 'default'), /No default provider configured/);
assert.throws(() => resolveTargets(noDefault, null), /No default provider configured/);
console.log('OK 4. missing default → clear error (never silent)');

// ── 5. Cascade: delete model/provider prunes aliases ────────────────
mgr.deleteModel('prov2', 'm1');
assert.equal(mgr.listAliases()['prov2/m1'], undefined, 'alias pruned with model');
mgr.deleteProvider('prov2');
assert.equal(Object.keys(mgr.listAliases()).filter(a => a.includes('prov2')).length, 0);
assert.ok(validateConfig(mgr.getConfig()).valid);
console.log('OK 5. cascades prune aliases and keep config valid');

// ── 6. Live: /v1/models shows ONLY aliases + default ─────────────────
const { startServer } = await import('../src/server/index.js');
await startServer();
const LOCAL = { 'Authorization': 'Bearer sk-local-alias-test' };

const modelsResp = await fetch('http://localhost:19996/v1/models', { headers: LOCAL });
const modelsJson = await modelsResp.json();
const ids = modelsJson.data.map(m => m.id);
assert.ok(ids.includes('default'), 'default listed');
assert.ok(ids.includes('prov1/m1') && ids.includes('brief'), 'aliases listed');
assert.ok(!ids.includes('m1') && !ids.includes('m2') && !ids.includes('real-m1') && !ids.includes('real-m2'),
  'raw model/realModel names must NOT appear');
console.log('OK 6. /v1/models shows only aliases + default →', ids.join(', '));

// ── 7. Live: alias request + account rotation on 429 ─────────────────
seen.length = 0;
const resp = await fetch('http://localhost:19996/v1/chat/completions', {
  method: 'POST',
  headers: { ...LOCAL, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'prov1/m1', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal(resp.status, 200, 'rotation must end in success');
assert.equal(seen.length, 2, 'two upstream attempts (A exhausted → B)');
assert.ok(String(seen[0].key).includes('key-a'), 'first try = default account A');
assert.ok(String(seen[1].key).includes('key-b'), 'second try = rotated account B');
assert.equal(seen[1].model, 'real-m1', 'upstream gets realModel');
const json = await resp.json();
assert.equal(json.model, 'prov1/m1', 'client sees the alias name back');
console.log('OK 7. 429 on account A → auto-rotated to account B → success');

// ── 8. Live: "default" model + unknown name both work ────────────────
seen.length = 0;
const dResp = await fetch('http://localhost:19996/v1/chat/completions', {
  method: 'POST',
  headers: { ...LOCAL, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal(dResp.status, 200);
assert.equal(seen[seen.length - 1].model, 'real-m1');

const uResp = await fetch('http://localhost:19996/v1/chat/completions', {
  method: 'POST',
  headers: { ...LOCAL, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'claude-some-random-model', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal(uResp.status, 200, 'unknown model must fall back to default provider');
assert.equal(seen[seen.length - 1].model, 'real-m1');
console.log('OK 8. "default" and unknown names both served by default provider');

// ── 9. Live: all accounts exhausted → clear 502 ───────────────────────
fs.writeFileSync(configFile, JSON.stringify({
  ...JSON.parse(fs.readFileSync(configFile, 'utf-8')),
  providers: {
    ...JSON.parse(fs.readFileSync(configFile, 'utf-8')).providers,
    prov1: {
      ...JSON.parse(fs.readFileSync(configFile, 'utf-8')).providers.prov1,
      accounts: [{ name: 'A', apiKey: 'sk-key-a', isDefault: true }], // only the exhausted one
    },
  },
}));

const xResp = await fetch('http://localhost:19996/v1/chat/completions', {
  method: 'POST',
  headers: { ...LOCAL, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'prov1/m1', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal(xResp.status, 502);
const xJson = await xResp.json();
assert.ok(xJson.error.message.includes('Accounts tried') || xJson.error.message.includes('failed'),
  'error should mention accounts tried');
console.log('OK 9. all accounts exhausted → 502 with account summary');

console.log('\nAll alias + rotation checks passed.');
mockUpstream.close();
process.exit(0);
