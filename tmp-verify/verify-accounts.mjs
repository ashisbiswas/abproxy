/**
 * Temporary verification script — exercises the multi-account config layer.
 * MUST be run with USERPROFILE/HOME pointed at a throwaway directory so the
 * real ~/.abproxy/config.json is never touched. Deleted after the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const configDir = path.join(os.homedir(), '.abproxy');
const configFile = path.join(configDir, 'config.json');

// Safety guard: refuse to run against a real home directory.
if (!/abproxy-verify/i.test(configDir)) {
  console.error(`Refusing to run: home is not a sandbox (${configDir})`);
  process.exit(1);
}

// ── Seed a LEGACY config (single apiKey) ─────────────────────────────
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configFile, JSON.stringify({
  port: 1986,
  localApiKey: 'sk-local-test',
  defaultModel: null,
  providers: {
    seekai: {
      aliases: ['sk'],
      type: 'openai-compatible',
      baseURL: 'https://seekai.cc/v1',
      apiKey: 'sk-legacy-key-1234567890',
      autoFetch: true,
      models: { 'glm-5': { realModel: 'glm-5', aliases: ['glm'] } },
    },
    anth: {
      aliases: [],
      type: 'anthropic-native',
      baseURL: 'https://api.anthropic.com',
      apiKey: 'sk-ant-legacy-0987654321',
      autoFetch: true,
      models: { opus: { realModel: 'claude-opus-4', aliases: [] } },
    },
  },
  modelGroups: {},
}, null, 2));

const mgr = await import('../src/config/manager.js');
const { validateConfig } = await import('../src/config/schema.js');
const { buildUpstreamHeaders } = await import('../src/server/adapters.js');

// ── 1. Auto-migration on read ────────────────────────────────────────
const config = mgr.getConfig();
assert.equal(config.providers.seekai.apiKey, undefined, 'legacy apiKey should be removed');
assert.deepEqual(config.providers.seekai.accounts, [
  { name: 'Default', apiKey: 'sk-legacy-key-1234567890', isDefault: true },
], 'legacy key should move into accounts[0]');
assert.ok(validateConfig(config).valid, 'migrated config must validate');
assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf-8')).providers.anth.accounts.length, 1,
  'migration must be persisted to disk');
console.log('OK 1. legacy apiKey auto-migrated to accounts[0] and persisted');

// ── 2. Active key helpers ────────────────────────────────────────────
assert.equal(mgr.getActiveApiKey(config.providers.seekai), 'sk-legacy-key-1234567890');
assert.equal(mgr.getActiveAccountName(config.providers.seekai), 'Default');
console.log('OK 2. getActiveApiKey / getActiveAccountName return the default account');

// ── 3. Account CRUD ──────────────────────────────────────────────────
mgr.addAccount('seekai', { name: 'Backup', apiKey: 'sk-backup-key-aaaa' });
assert.equal(mgr.listAccounts('seekai').length, 2);
assert.equal(mgr.listAccounts('seekai').filter(a => a.isDefault).length, 1, 'exactly one default');
assert.equal(mgr.getActiveApiKey(mgr.getProvider('seekai')), 'sk-legacy-key-1234567890',
  'adding a non-default account must not change the active key');
assert.throws(() => mgr.addAccount('seekai', { name: 'Backup', apiKey: 'x' }), /already exists/);
mgr.addAccount('sk', { name: 'ViaAlias', apiKey: 'sk-alias-key-bbbb' });
assert.equal(mgr.listAccounts('seekai').length, 3, 'alias should resolve to the provider');
console.log('OK 3. addAccount works (incl. alias resolution + duplicate guard)');

// ── 4. Set default account switches the active key ───────────────────
mgr.setDefaultAccount('seekai', 'Backup');
assert.equal(mgr.getActiveApiKey(mgr.getProvider('seekai')), 'sk-backup-key-aaaa');
assert.equal(mgr.listAccounts('seekai').filter(a => a.isDefault).length, 1);
assert.equal(mgr.getActiveAccountName(mgr.getProvider('seekai')), 'Backup');
console.log('OK 4. setDefaultAccount switches the active key');

// ── 5. Headers use the active account key ────────────────────────────
const oaiHeaders = buildUpstreamHeaders(mgr.getProvider('seekai'), false);
assert.equal(oaiHeaders['Authorization'], 'Bearer sk-backup-key-aaaa');
const antHeaders = buildUpstreamHeaders(mgr.getProvider('anth'), false);
assert.equal(antHeaders['x-api-key'], 'sk-ant-legacy-0987654321');
assert.equal(antHeaders['anthropic-version'], '2023-06-01');
console.log('OK 5. buildUpstreamHeaders uses the active account key');

// ── 6. Edit account (rename + rotate key) ────────────────────────────
mgr.editAccount('seekai', 'Backup', { name: 'Backup2', apiKey: 'sk-rotated-cccc' });
assert.equal(mgr.getActiveApiKey(mgr.getProvider('seekai')), 'sk-rotated-cccc');
assert.equal(mgr.getActiveAccountName(mgr.getProvider('seekai')), 'Backup2');
console.log('OK 6. editAccount renames and rotates the key');

// ── 7. Deleting the default promotes another account ─────────────────
mgr.deleteAccount('seekai', 'Backup2');
const remaining = mgr.listAccounts('seekai');
assert.equal(remaining.length, 2);
assert.equal(remaining.filter(a => a.isDefault).length, 1, 'a new default must be promoted');
assert.equal(remaining[0].isDefault, true);
assert.throws(() => mgr.deleteAccount('seekai', 'Nope'), /not found/);
console.log('OK 7. deleteAccount promotes a new default');

// ── 8. addProvider with accounts[] and with legacy apiKey ────────────
mgr.addProvider('gorouter', {
  type: 'openai-compatible',
  baseURL: 'https://gorouter.app/v1',
  aliases: ['gr'],
  accounts: [
    { name: 'Main', apiKey: 'sk-gr-main', isDefault: false },
    { name: 'Alt', apiKey: 'sk-gr-alt', isDefault: true },
  ],
  models: {},
});
assert.equal(mgr.getActiveApiKey(mgr.getProvider('gorouter')), 'sk-gr-alt');
mgr.addProvider('legacyAdd', {
  type: 'openai-compatible',
  baseURL: 'https://legacy.example.com/v1',
  apiKey: 'sk-legacy-add',
});
assert.deepEqual(mgr.listAccounts('legacyAdd'), [
  { name: 'Default', apiKey: 'sk-legacy-add', isDefault: true },
]);
console.log('OK 8. addProvider accepts accounts[] and legacy apiKey');

// ── 9. Config stays valid throughout ─────────────────────────────────
const finalValidation = validateConfig(mgr.getConfig());
assert.ok(finalValidation.valid, `config invalid: ${finalValidation.errors.join('; ')}`);
console.log('OK 9. final config validates');

console.log('\nAll multi-account config checks passed.');

