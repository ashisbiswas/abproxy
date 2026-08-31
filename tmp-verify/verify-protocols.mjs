/**
 * Temporary verification script — dual-protocol provider support.
 * A mock upstream exposes BOTH /v1/chat/completions (Bearer) and
 * /v1/messages (x-api-key); asserts abproxy passes each client format
 * through natively with the correct auth header and URL.
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

// ── Mock dual-protocol upstream: records what it receives ────────────
const seen = [];
const mockUpstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const hit = {
      url: req.url,
      auth: req.headers['authorization'] || null,
      xApiKey: req.headers['x-api-key'] || null,
      anthropicVersion: req.headers['anthropic-version'] || null,
      body: body ? JSON.parse(body) : null,
    };
    seen.push(hit);

    const isAnthropic = req.url.includes('/messages');
    res.setHeader('content-type', 'application/json');
    if (isAnthropic) {
      res.end(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant', model: hit.body.model,
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    } else {
      res.end(JSON.stringify({
        id: 'chatcmpl-x', object: 'chat.completion', created: 1, model: hit.body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    }
  });
});
await new Promise(r => mockUpstream.listen(19790, r));

// ── Seed config: dual-protocol + openai-only providers ──────────────
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({
  port: 19997,
  localApiKey: 'sk-local-dual-test',
  defaultProvider: 'dual',
  defaultModel: null,
  providers: {
    dual: {
      aliases: [], type: 'openai-compatible',
      baseURL: 'http://localhost:19790',
      protocols: ['openai', 'anthropic'],
      defaultModel: 'm1',
      autoFetch: false,
      models: { 'm1': { realModel: 'real-m1' } },
      accounts: [{ name: 'Default', apiKey: 'sk-dual-key', isDefault: true }],
    },
    oaiOnly: {
      aliases: [], type: 'openai-compatible',
      baseURL: 'http://localhost:19790',
      defaultModel: 'm2',
      autoFetch: false,
      models: { 'm2': { realModel: 'real-m2' } },
      accounts: [{ name: 'Default', apiKey: 'sk-oai-key', isDefault: true }],
    },
  },
  aliases: {
    'dual/m1': { provider: 'dual', model: 'm1' },
    'oaiOnly/m2': { provider: 'oaiOnly', model: 'm2' },
  },
}, null, 2));

const { validateConfig } = await import('../src/config/schema.js');
const { getSupportedProtocols, buildUpstreamUrl, buildUpstreamHeaders } = await import('../src/server/adapters.js');
const { resolveTargets } = await import('../src/server/resolver.js');
const mgr = await import('../src/config/manager.js');

// ── 1. getSupportedProtocols: explicit, legacy-openai, legacy-anthropic ─
const config = mgr.getConfig();
assert.deepEqual(getSupportedProtocols(config.providers.dual), ['openai', 'anthropic']);
assert.deepEqual(getSupportedProtocols(config.providers.oaiOnly), ['openai']);
assert.deepEqual(getSupportedProtocols({ type: 'anthropic-native' }), ['anthropic']);
console.log('OK 1. getSupportedProtocols (explicit + type fallbacks)');

// ── 2. URL + header builders are protocol-aware ──────────────────────
const dual = config.providers.dual;
assert.equal(buildUpstreamUrl(dual, 'anthropic'), 'http://localhost:19790/v1/messages');
assert.equal(buildUpstreamUrl(dual, 'openai'), 'http://localhost:19790/v1/chat/completions');
const antH = buildUpstreamHeaders(dual, false, {}, 'anthropic');
assert.equal(antH['x-api-key'], 'sk-dual-key');
assert.equal(antH['anthropic-version'], '2023-06-01');
assert.equal(antH['Authorization'], undefined, 'anthropic hop must NOT use Bearer');
const oaiH = buildUpstreamHeaders(dual, false, {}, 'openai');
assert.equal(oaiH['Authorization'], 'Bearer sk-dual-key');
assert.equal(oaiH['x-api-key'], undefined, 'openai hop must NOT use x-api-key');
console.log('OK 2. buildUpstreamUrl/Headers pick endpoint + auth per protocol');

// ── 3. Schema validation of protocols field ──────────────────────────
assert.ok(validateConfig(config).valid, 'valid protocols must pass');
const badCfg = JSON.parse(JSON.stringify(config));
badCfg.providers.dual.protocols = ['ftp'];
assert.ok(!validateConfig(badCfg).valid, 'invalid protocol name must fail');
console.log('OK 3. schema validates the protocols array');

// ── 4. Live: Anthropic client → dual provider → native /v1/messages ───
const { startServer } = await import('../src/server/index.js');
await startServer();

const LOCAL = { 'Authorization': 'Bearer sk-local-dual-test', 'Content-Type': 'application/json' };

const antResp = await fetch('http://localhost:19997/v1/messages', {
  method: 'POST',
  headers: { ...LOCAL, 'x-api-key': 'sk-local-dual-test' },
  body: JSON.stringify({
    model: 'dual/m1', max_tokens: 64, system: 'be brief',
    messages: [{ role: 'user', content: 'hi' }],
  }),
});
assert.equal(antResp.status, 200);
const antJson = await antResp.json();
assert.equal(antJson.type, 'message', 'client must get an Anthropic-shaped response');
const upstreamAnt = seen[seen.length - 1];
assert.equal(upstreamAnt.url, '/v1/messages', 'upstream must be the native Anthropic endpoint');
assert.equal(upstreamAnt.xApiKey, 'sk-dual-key', 'upstream must receive x-api-key (real key)');
assert.equal(upstreamAnt.body.system, 'be brief', 'system prompt survives passthrough');
assert.equal(upstreamAnt.body.model, 'real-m1', 'upstream gets realModel');
console.log('OK 4. Anthropic client → dual provider → native /v1/messages with x-api-key');

// ── 5. Live: OpenAI client → same dual provider → /v1/chat/completions ─
const oaiResp = await fetch('http://localhost:19997/v1/chat/completions', {
  method: 'POST',
  headers: LOCAL,
  body: JSON.stringify({ model: 'dual/m1', messages: [{ role: 'user', content: 'hi' }] }),
});
assert.equal(oaiResp.status, 200);
const oaiJson = await oaiResp.json();
assert.equal(oaiJson.object, 'chat.completion', 'client must get an OpenAI-shaped response');
const upstreamOai = seen[seen.length - 1];
assert.equal(upstreamOai.url, '/v1/chat/completions', 'upstream must be the OpenAI endpoint');
assert.equal(upstreamOai.auth, 'Bearer sk-dual-key', 'upstream must receive Bearer (real key)');
console.log('OK 5. OpenAI client → same provider → /v1/chat/completions with Bearer');

// ── 6. Live: Anthropic client → openai-ONLY provider → translated ────
const xResp = await fetch('http://localhost:19997/v1/messages', {
  method: 'POST',
  headers: { ...LOCAL, 'x-api-key': 'sk-local-dual-test' },
  body: JSON.stringify({
    model: 'oaiOnly/m2', max_tokens: 64,
    messages: [{ role: 'user', content: 'hi' }],
  }),
});
assert.equal(xResp.status, 200);
const xJson = await xResp.json();
assert.equal(xJson.type, 'message', 'client still gets Anthropic shape back');
const upstreamX = seen[seen.length - 1];
assert.equal(upstreamX.url, '/v1/chat/completions', 'openai-only provider must be called via OpenAI endpoint');
assert.equal(upstreamX.auth, 'Bearer sk-oai-key');
console.log('OK 6. Anthropic client → openai-only provider → translated both ways');

console.log('\nAll dual-protocol checks passed.');
mockUpstream.close();
process.exit(0);
