/**
 * Agent registry + wrapper state manager.
 *
 * An "agent" is a CLI coding tool (Claude Code, OpenCode, Codex) that can be
 * pointed at abproxy by patching its own config file. Wrapping an agent:
 *   1. backs the original config up next to itself as <config>.abproxy.bak
 *   2. patches the config so the agent's traffic goes to the abproxy endpoint
 *
 * "Unwrapping" (stopping the wrapper) restores the backup over the config and
 * deletes the backup.
 *
 * Wrapper metadata lives in ~/.abproxy/wrappers.json, but the agent config
 * content itself is the source of truth — so state survives app removal, and
 * leftover .abproxy.bak files are detected on the next run and offered for
 * restore.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfig, getEffectiveDefaultModel } from '../config/manager.js';

const ABPROXY_DIR = path.join(os.homedir(), '.abproxy');
const WRAPPERS_FILE = path.join(ABPROXY_DIR, 'wrappers.json');
const BACKUP_SUFFIX = '.abproxy.bak';

// ─── Small helpers ───────────────────────────────────────────────────

function homePath(...segments) {
  return path.join(os.homedir(), ...segments);
}

function fileExists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * True if `cmd` can be found on PATH. Handles Windows PATHEXT, so `claude`
 * matches claude.cmd / claude.exe / claude.ps1 too.
 */
function isOnPath(cmd) {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toLowerCase()), '.ps1']
    : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, cmd + ext))) return true;
      } catch {}
    }
  }
  return false;
}

/**
 * Does a localhost URL point at one of the given abproxy ports?
 */
function urlMatchesPort(url, ports) {
  const m = /^https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(url || '');
  return !!m && ports.includes(parseInt(m[1], 10));
}

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Parse JSON or JSONC (comments / trailing commas). Returns
 * { json, hadComments } or null when unparseable even after cleanup.
 * Used because OpenCode configs are often .jsonc with comments.
 */
function tryParseJsonc(raw) {
  if (!raw || !raw.trim()) return { json: {}, hadComments: false };
  try {
    return { json: JSON.parse(raw), hadComments: false };
  } catch {}

  // Pass 1: remove // and /* */ comments (string-literal aware)
  let noComments = '';
  let inStr = false, inLine = false, inBlock = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const n = raw[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; noComments += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      noComments += c;
      if (c === '\\' && n !== undefined) { noComments += n; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; noComments += c; continue; }
    if (c === '/' && n === '/') { inLine = true; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    noComments += c;
  }

  // Pass 2: drop trailing commas (string-literal aware)
  let cleaned = '';
  inStr = false;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inStr) {
      cleaned += c;
      if (c === '\\') { cleaned += noComments[i + 1] || ''; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cleaned += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === '}' || noComments[j] === ']') continue;
    }
    cleaned += c;
  }

  try {
    return { json: JSON.parse(cleaned), hadComments: true };
  } catch {
    return null;
  }
}

// ─── Agent definitions ───────────────────────────────────────────────
// Each agent owns three content operations:
//   isWrapped(raw, ports) — does this config route through abproxy?
//   wrap(raw, { baseURL, apiKey, config }) — patched content
//   strip(raw) — best-effort abproxy-key removal (used when no backup exists)

const AGENTS = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    binaries: ['claude'],
    detectPaths: () => [homePath('.claude'), homePath('.claude.json')],
    configCandidates: () => [homePath('.claude', 'settings.json')],
    endpointSuffix: '',
    envKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],

    isWrapped(raw, ports) {
      const json = parseJsonSafe(raw);
      if (json && json.env && json.env.ANTHROPIC_BASE_URL) {
        return urlMatchesPort(json.env.ANTHROPIC_BASE_URL, ports);
      }
      return /"ANTHROPIC_BASE_URL"\s*:/.test(raw) && ports.some(p => raw.includes(`localhost:${p}`));
    },

    wrap(raw, { baseURL, apiKey }) {
      let settings = {};
      if (raw.trim()) {
        settings = parseJsonSafe(raw);
        if (settings === undefined) {
          throw new Error('~/.claude/settings.json is not valid JSON — fix or remove it first');
        }
      }
      settings.env = settings.env || {};
      settings.env.ANTHROPIC_BASE_URL = baseURL;
      settings.env.ANTHROPIC_API_KEY = apiKey;
      return JSON.stringify(settings, null, 2);
    },

    strip(raw) {
      const settings = parseJsonSafe(raw);
      if (!settings) return null;
      if (settings.env) {
        delete settings.env.ANTHROPIC_BASE_URL;
        delete settings.env.ANTHROPIC_API_KEY;
        if (Object.keys(settings.env).length === 0) delete settings.env;
      }
      return JSON.stringify(settings, null, 2);
    },
  },

  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    binaries: ['opencode'],
    detectPaths: () => [homePath('.config', 'opencode'), homePath('.opencode')],
    configCandidates: () => [
      homePath('.config', 'opencode', 'opencode.json'),
      homePath('.config', 'opencode', 'opencode.jsonc'),
      homePath('.opencode', 'config.json'),
    ],
    endpointSuffix: '/v1',

    isWrapped(raw, ports) {
      const parsed = tryParseJsonc(raw);
      const entry = parsed && parsed.json && parsed.json.provider && parsed.json.provider.abproxy;
      if (entry) {
        // Current shape: options.baseURL. Also accept the legacy flat
        // baseURL so configs wrapped by older abproxy versions still read
        // as wrapped.
        return urlMatchesPort((entry.options && entry.options.baseURL) || entry.baseURL, ports);
      }
      return /"abproxy"/.test(raw) && ports.some(p => raw.includes(`localhost:${p}`));
    },

    wrap(raw, { baseURL, apiKey, config }) {
      const parsed = tryParseJsonc(raw);
      if (!parsed) {
        throw new Error('opencode config is not valid JSON/JSONC — fix or remove it first');
      }
      const cfg = parsed.json;
      cfg.provider = cfg.provider || {};

      // OpenCode only shows the models listed here — capture the current
      // aliases (the names abproxy serves at /v1/models) plus "default".
      const models = { default: { name: 'default' } };
      for (const alias of Object.keys(config.aliases || {})) {
        models[alias] = { name: alias };
      }

      cfg.provider.abproxy = {
        name: 'abproxy',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL, apiKey },
        models,
      };

      const result = { content: JSON.stringify(cfg, null, 2), notices: [] };
      if (parsed.hadComments) {
        result.notices.push('Comments / trailing commas were removed from the config (they cannot be merged safely).');
      }
      return result;
    },

    strip(raw) {
      const parsed = tryParseJsonc(raw);
      const cfg = parsed && parsed.json;
      if (!cfg || !cfg.provider || !cfg.provider.abproxy) return null;
      delete cfg.provider.abproxy;
      if (Object.keys(cfg.provider).length === 0) delete cfg.provider;
      return JSON.stringify(cfg, null, 2);
    },
  },

  codex: {
    id: 'codex',
    label: 'Codex',
    binaries: ['codex'],
    detectPaths: () => [homePath('.codex')],
    configCandidates: () => [homePath('.codex', 'config.toml')],
    endpointSuffix: '/v1',

    isWrapped(raw, ports) {
      if (!/\[model_providers\.abproxy\]/.test(raw)) return false;
      return ports.some(p => new RegExp(`base_url\\s*=\\s*"[^"]*localhost:${p}`).test(raw));
    },

    wrap(raw, { baseURL, apiKey, config }) {
      let out = raw || '';

      // Codex validates: `name` must be non-empty, `wire_api` must be
      // "responses" ("chat" was removed), and there is no `api_key` field —
      // auth is env_key / experimental_bearer_token. The bearer token keeps
      // the wrapper self-contained (no shell env var needed); it only
      // grants access to the local abproxy endpoint.
      const section = [
        '[model_providers.abproxy]',
        'name = "abproxy"',
        `base_url = "${baseURL}"`,
        'wire_api = "responses"',
        `experimental_bearer_token = "${apiKey}"`,
        'requires_openai_auth = false',
      ].join('\n');

      const sectionRegex = /\[model_providers\.abproxy\]\n?[^[]*/;
      if (sectionRegex.test(out)) {
        out = out.replace(sectionRegex, () => section + '\n\n');
      } else {
        out = out.trimEnd() + (out.trim() ? '\n\n' : '') + section + '\n';
      }

      // Codex only uses the provider when model_provider points at it.
      // The pre-wrap value is preserved in the backup for restore.
      if (/^model_provider\s*=/m.test(out)) {
        out = out.replace(/^model_provider\s*=.*$/m, () => 'model_provider = "abproxy"');
      } else {
        out = 'model_provider = "abproxy"\n\n' + out;
      }

      // Point at an abproxy-visible model name (alias or the literal
      // "default" — abproxy resolves both). /^model\s*=/ matches only a
      // true `model` key — not model_provider / model_reasoning_effort.
      const eff = getEffectiveDefaultModel(config);
      const modelLine = `model = "${eff ? eff.modelName : 'default'}"`;
      if (/^model\s*=/m.test(out)) {
        out = out.replace(/^model\s*=.*$/m, () => modelLine);
      } else {
        out = modelLine + '\n' + out;
      }
      return out;
    },

    strip(raw, config) {
      let out = raw.replace(/\[model_providers\.abproxy\]\n?[^[]*/g, '');
      out = out.replace(/^model_provider\s*=\s*"abproxy"\s*\n/m, '');

      // Remove the model line only when it points at an abproxy-managed
      // name (alias / "default" / effective default) — never a value the
      // user chose for another provider.
      const managed = new Set(['default', ...(config ? Object.keys(config.aliases || {}) : [])]);
      if (config) {
        const eff = getEffectiveDefaultModel(config);
        if (eff) managed.add(eff.modelName);
      }
      out = out.replace(/^model\s*=\s*"([^"]*)".*\n/mg, (line, val) => (managed.has(val) ? '' : line));

      return out === raw ? null : out;
    },
  },
};

// ─── Wrapper state (~/.abproxy/wrappers.json) ────────────────────────

function readWrapperState() {
  try {
    if (fileExists(WRAPPERS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(WRAPPERS_FILE, 'utf-8'));
      if (parsed && typeof parsed.wrappers === 'object') return parsed;
    }
  } catch {}
  return { version: 1, wrappers: {} };
}

function writeWrapperState(state) {
  if (!fs.existsSync(ABPROXY_DIR)) {
    fs.mkdirSync(ABPROXY_DIR, { recursive: true });
  }
  fs.writeFileSync(WRAPPERS_FILE, JSON.stringify(state, null, 2));
}

export function getWrapperMeta(id) {
  return readWrapperState().wrappers[id] || null;
}

function setWrapperMeta(id, meta) {
  const state = readWrapperState();
  state.wrappers[id] = meta;
  writeWrapperState(state);
}

function removeWrapperMeta(id) {
  const state = readWrapperState();
  if (state.wrappers[id]) {
    delete state.wrappers[id];
    writeWrapperState(state);
  }
}

// ─── Detection & paths ───────────────────────────────────────────────

export function listAgentIds() {
  return Object.keys(AGENTS);
}

export function getAgent(id) {
  return AGENTS[id] || null;
}

function detectAgent(agent) {
  for (const bin of agent.binaries) {
    if (isOnPath(bin)) return { installed: true, via: `"${bin}" on PATH` };
  }
  for (const p of agent.detectPaths()) {
    if (fs.existsSync(p)) {
      return { installed: true, via: '~/' + path.relative(os.homedir(), p).replace(/\\/g, '/') + '/' };
    }
  }
  for (const c of agent.configCandidates()) {
    if (fileExists(c)) return { installed: true, via: 'config found' };
  }
  return { installed: false, via: null };
}

/**
 * First config candidate that exists; otherwise the primary (creation) path.
 */
export function resolveConfigPath(agent) {
  for (const c of agent.configCandidates()) {
    if (fileExists(c)) return c;
  }
  return agent.configCandidates()[0];
}

export function backupPathFor(configPath) {
  return configPath + BACKUP_SUFFIX;
}

// ─── Wrap state inspection ───────────────────────────────────────────

function computeWrapped(agent, meta, config) {
  const ports = [config.port];
  if (meta && meta.port) ports.push(meta.port);
  const configPath = resolveConfigPath(agent);
  if (!fileExists(configPath)) return false;
  try {
    return agent.isWrapped(fs.readFileSync(configPath, 'utf-8'), [...new Set(ports)]);
  } catch {
    return false;
  }
}

/**
 * Status snapshot for every known agent:
 *   { id, label, installed, via, configPath, backupPath, wrapped,
 *     backupExists, meta }
 */
export function listAgents(config = getConfig()) {
  reconcileState(config);
  return listAgentIds().map(id => {
    const agent = AGENTS[id];
    const { installed, via } = detectAgent(agent);
    const configPath = resolveConfigPath(agent);
    const backupPath = backupPathFor(configPath);
    const meta = getWrapperMeta(id);
    const wrapped = computeWrapped(agent, meta, config);
    return {
      id,
      label: agent.label,
      installed,
      via,
      configPath,
      backupPath,
      wrapped,
      backupExists: fileExists(backupPath),
      meta,
    };
  });
}

/**
 * Drop state entries that no longer match reality (agent neither wrapped
 * nor a backup left) — e.g. after the user restored manually and deleted
 * the backup themselves.
 */
function reconcileState(config) {
  const state = readWrapperState();
  let changed = false;
  for (const [id, meta] of Object.entries(state.wrappers)) {
    const agent = AGENTS[id];
    if (!agent) {
      delete state.wrappers[id];
      changed = true;
      continue;
    }
    const wrapped = computeWrapped(agent, meta, config);
    const backupExists = meta.backupPath ? fileExists(meta.backupPath) : false;
    if (!wrapped && !backupExists) {
      delete state.wrappers[id];
      changed = true;
    }
  }
  if (changed) writeWrapperState(state);
}

/**
 * Backups that exist but belong to no active wrapper — typically left over
 * after the app itself was removed/reinstalled. Restorable via unwrap.
 */
export function findOrphanBackups(config = getConfig()) {
  return listAgents(config).filter(a => a.backupExists && !a.wrapped);
}

// ─── Wrap / Unwrap ───────────────────────────────────────────────────

/**
 * Point an agent at abproxy. Creates <config>.abproxy.bak on first wrap
 * (never overwrites an existing backup — it holds the true original).
 */
export function wrapAgent(id) {
  const agent = AGENTS[id];
  if (!agent) throw new Error(`Unknown agent "${id}"`);

  const config = getConfig();
  const baseURL = `http://localhost:${config.port}${agent.endpointSuffix}`;
  const configPath = resolveConfigPath(agent);
  const backupPath = backupPathFor(configPath);

  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const raw = fileExists(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
  const wasWrapped = agent.isWrapped(raw, [config.port]);

  let createdBackup = false;
  if (!wasWrapped && !fileExists(backupPath)) {
    fs.writeFileSync(backupPath, raw);
    createdBackup = true;
  }

  const out = agent.wrap(raw, { baseURL, apiKey: config.localApiKey, config });
  const updated = typeof out === 'string' ? out : out.content;
  fs.writeFileSync(configPath, updated);

  setWrapperMeta(id, {
    configPath,
    backupPath,
    port: config.port,
    baseURL,
    wrappedAt: new Date().toISOString(),
  });

  return {
    id,
    label: agent.label,
    configPath,
    backupPath,
    baseURL,
    apiKey: config.localApiKey,
    wasWrapped,
    createdBackup,
    notices: typeof out === 'string' ? [] : (out.notices || []),
  };
}

/**
 * Stop a wrapper: restore the original config from the backup (and delete
 * the backup). Without a backup, best-effort strips the abproxy keys from
 * the config. Safe to call when nothing is wrapped.
 */
export function unwrapAgent(id) {
  const agent = AGENTS[id];
  if (!agent) throw new Error(`Unknown agent "${id}"`);

  const configPath = resolveConfigPath(agent);
  const backupPath = backupPathFor(configPath);

  if (fileExists(backupPath)) {
    const original = fs.readFileSync(backupPath, 'utf-8');
    if (original.trim() === '') {
      // The config file did not exist before the wrap — remove what we created.
      if (fileExists(configPath)) fs.unlinkSync(configPath);
    } else {
      fs.writeFileSync(configPath, original);
    }
    fs.unlinkSync(backupPath);
    removeWrapperMeta(id);
    return { id, label: agent.label, restored: true, from: 'backup', configPath, backupPath };
  }

  const meta = getWrapperMeta(id);
  const ports = [getConfig().port];
  if (meta && meta.port) ports.push(meta.port);

  const raw = fileExists(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
  if (raw && agent.isWrapped(raw, [...new Set(ports)])) {
    const stripped = agent.strip(raw, getConfig());
    if (stripped !== null) {
      fs.writeFileSync(configPath, stripped);
      removeWrapperMeta(id);
      return { id, label: agent.label, restored: true, from: 'strip', configPath };
    }
  }

  removeWrapperMeta(id);
  return { id, label: agent.label, restored: false, from: 'none', configPath };
}

// ─── Server liveness ─────────────────────────────────────────────────

function readDaemonPid() {
  try {
    const pidFile = path.join(ABPROXY_DIR, 'daemon.pid');
    if (fileExists(pidFile)) {
      return parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    }
  } catch {}
  return null;
}

/**
 * Fast, synchronous check: is a daemon process registered and alive?
 * (A foreground `abproxy start --foreground` has no pid file — use
 * isServerAlive() for the accurate answer.)
 */
export function isServerRunning() {
  const pid = readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accurate check: daemon pid OR anything answering /health on our port
 * (covers foreground servers). Falls back quickly when nothing is there.
 */
export async function isServerAlive() {
  if (isServerRunning()) return true;
  try {
    const config = getConfig();
    const resp = await fetch(`http://localhost:${config.port}/health`, {
      signal: AbortSignal.timeout(600),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
