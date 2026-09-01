# abproxy

> Local LLM gateway/proxy — one endpoint, many providers, automatic account rotation.

Point every AI agent (Claude Code, opencode, codex, your own apps) at one stable `http://localhost:1986` endpoint, and swap real providers/models/keys behind it without touching agent configs.

## Quick Start

```bash
# Install
npm install
npm link     # makes 'abproxy' available globally

# Launch interactive REPL
abproxy

# Or use CLI commands directly
abproxy provider add
abproxy alias add
abproxy start
```

## How it works

```
Agents ──► http://localhost:1986 ──► abproxy ──► provider accounts
            model = alias name          │          (rotate on quota)
            or "default"                └── real provider/model/key
```

1. **Add providers** — each with one or more accounts (API keys).
2. **Create aliases** — the *only* model names agents ever see. Suggested form: `provider/model-name`, e.g. `gorouter/claude-opus-4-8`.
3. **Point agents** at `http://localhost:1986` with the local API key. In the agent's model field, use an alias or the literal `default`.

### What agents see at /v1/models

**Only aliases** (plus `default`). If no alias is created, no model is shown. This solves the "same model name on many providers" problem — the alias pins a name to exactly one provider and model.

### Model resolution

| Request model field | Resolves to |
|---|---|
| `gorouter/claude-opus-4-8` (an alias) | exactly that provider + model |
| `default` (literal) | default provider's default model |
| *(empty)* | default provider's default model |
| anything unknown | default provider's default model — never a hard error |

Aliases and defaults are **pinned to one provider** — requests never silently go elsewhere. Instead, when a provider account is rate-limited/exhausted (HTTP 429/402/401/403), abproxy **rotates to the provider's next account** automatically and retries.

## Features

- **One local endpoint** (`http://localhost:1986`) for all your agents
- **Aliases as agent-visible model names** — pin any name to any provider/model
- **Multi-provider** — Anthropic-native and OpenAI-compatible APIs
- **Dual-protocol providers** — native passthrough when upstream supports the client's protocol
- **OpenAI Responses API** (`/v1/responses`) — Codex CLI works out of the box, translated to any upstream
- **Multi-account providers** — several API keys per provider, one active
- **Automatic account rotation** — quota exhausted → next account, transparently
- **Default provider + per-provider default model** — `default` just works
- **Auto model discovery** — fetches available models from provider's `/v1/models`
- **Config hot-reload** — edit config while server runs, changes apply instantly
- **Free provider list** — curated free-tier gateway URLs (`/free`), add one as a provider with a few keystrokes
- **Agent setup wrappers** — auto-detects Claude Code / opencode / codex, backs up their config, and points them at abproxy (with live wrapper status and one-keystroke restore)

## Free Provider List

`/free` (or main menu → Free Providers) shows a numbered list of curated free provider endpoints:

```
  Free provider list
  ────────────────────────────────────────────────
   1. TabiToken [openai]
      https://tabitoken.com
   2. GoRouter [openai + anthropic]
      https://gorouter.app
   ...
```

Pick a number and abproxy pre-fills the Add Provider flow (name, base URL, protocols) — you just supply the API key. The list lives in `src/data/free-providers.json`; edit it to add your own:

```json
{ "providers": [ { "name": "MyGateway", "url": "https://example.com", "protocols": ["openai"] } ] }
```

## Agent Wrappers

```bash
abproxy setup                 # interactive — lists only agents you actually have
abproxy setup list            # table: detection, wrapper status, config paths
abproxy setup claude-code     # wrap one agent directly
abproxy setup restore all     # stop all wrappers, restore original configs
```

`abproxy setup` **detects what is installed first** and only offers those agents:

| Agent | Detected via |
|---|---|
| Claude Code | `claude` on PATH, or `~/.claude` |
| OpenCode | `opencode` on PATH, or `~/.config/opencode` |
| Codex | `codex` on PATH, or `~/.codex` |

### Wrapping an agent

1. **Backup** — the original config is copied next to itself with `abproxy` appended: `~/.claude/settings.json` → `~/.claude/settings.json.abproxy.bak` (same for `~/.codex/config.toml` and the opencode config). The backup is created once and never overwritten, so the true original is always recoverable.
2. **Patch** — the config is updated to route through abproxy:
   - *Claude Code*: `env.ANTHROPIC_BASE_URL = http://localhost:1986` + `env.ANTHROPIC_API_KEY = <local key>`
   - *OpenCode*: a `provider.abproxy` entry in OpenCode's own shape — `npm: "@ai-sdk/openai-compatible"`, `options.baseURL` = `http://localhost:1986/v1`, `options.apiKey` = `<local key>` — plus a `models` map with your aliases and `default` (captured at wrap time; **Re-apply** after adding aliases). Both `opencode.json` and `opencode.jsonc` are detected.
   - *Codex*: a `[model_providers.abproxy]` section in Codex's own schema — `name`, `wire_api = "responses"`, `base_url = http://localhost:1986/v1`, auth via `experimental_bearer_token` (the local key — no shell env var needed) — plus `model_provider = "abproxy"` and `model = <alias or "default">`. Current Codex only speaks the Responses API, which abproxy serves at `POST /v1/responses` (translated to the chat/Anthropic pipeline with tool calls intact). Previous values are preserved in the backup.

### Tracking wrapper state

The setup menu (and banner) shows live status per agent:

- `● wrapper running` — the agent's config points at abproxy **and** the server is up
- `○ wrapper set — server stopped` — config is patched but the abproxy server isn't running
- `not configured` — agent installed, not wrapped

For an already-wrapped agent the menu offers **Stop wrapper** (restore original config from the backup and delete it), **Re-apply** (re-patch after a port/key change), and **Details**. The same is available from the shell via `abproxy setup restore [agent|all]`.

Wrapper state is stored in `~/.abproxy/wrappers.json`, but the agent's config **content is the source of truth** — so the status is still correct even if that file is deleted, and wrapping is idempotent.

### Uninstalling / cleanup

**Before deleting abproxy**, stop all wrappers so agents keep working with their original settings:

```bash
abproxy setup restore all    # or: /setup → each agent → Stop wrapper
```

If you already deleted the app without restoring:

- An agent config may still point at the dead `localhost:1986` endpoint. To fix manually, delete the patched config file and rename its `<name>.abproxy.bak` back to the original name.
- Or simply **reinstall abproxy** — startup detects leftover `.abproxy.bak` files, warns on the banner, and offers restore (`/setup` → agent → Stop wrapper, or `abproxy setup restore all`).
- `~/.abproxy/` holds config, logs, and wrapper state and survives app removal; delete it last, after restoring agent configs.

## Agent Configuration (manual)

```bash
abproxy setup claude-code   # or opencode / codex
```

Or set manually:

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://localhost:1986
export ANTHROPIC_API_KEY=sk-local-...

# Codex / opencode (OpenAI-compatible)
# Base URL: http://localhost:1986/v1
# API Key: sk-local-...
# Model:    an alias name, or "default"
```

## CLI Commands

### Providers
```bash
abproxy provider add                       # Interactive setup (accounts, models)
abproxy provider list                      # Table view
abproxy provider edit <name>               # Edit type/URL/protocols
abproxy provider delete <name>             # Delete + cascade aliases
abproxy provider test <name>               # Live ping test
abproxy provider sync <name>               # Re-fetch models from upstream
abproxy provider set-default <name>        # Default provider for "default"
abproxy provider default-model <name> [m]  # Per-provider default model
```

### Aliases (agent-visible model names)
```bash
abproxy alias list
abproxy alias add [name] [provider] [model]   # e.g. abproxy alias add gorouter/claude-opus-4-8 gorouter claude-opus-4-8
abproxy alias edit <name>
abproxy alias delete <name>
```

### Models (internal)
```bash
abproxy model add <provider>
abproxy model list [--provider p]
abproxy model edit <p> <m>
abproxy model delete <p> <m>          # cascades aliases
abproxy model set-default <m>         # global fallback default
abproxy model test <m>
```

### Daemon Control
```bash
abproxy start                # background daemon
abproxy start --foreground
abproxy stop
abproxy restart
abproxy status
abproxy logs [-f]
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check (no auth) |
| `GET /v1/models` | **Alias names + `default`** — nothing else |
| `GET /v1/models/:id` | Alias lookup (`:id` = alias name or `default`) |
| `POST /v1/chat/completions` | OpenAI-compatible completions |
| `POST /v1/responses` | OpenAI **Responses API** (Codex CLI) — translated to the chat pipeline |
| `POST /v1/messages` | Anthropic-native messages |

All endpoints (except `/health`) accept `Authorization: Bearer <localApiKey>` or `x-api-key: <localApiKey>`.

## Config Example

```json
{
  "port": 1986,
  "localApiKey": "sk-local-...",
  "defaultProvider": "gorouter",
  "defaultModel": null,
  "providers": {
    "gorouter": {
      "type": "openai-compatible",
      "baseURL": "https://gorouter.app",
      "protocols": ["openai", "anthropic"],
      "defaultModel": "claude-opus-4-8",
      "autoFetch": true,
      "accounts": [
        { "name": "Main", "apiKey": "sk-...", "isDefault": true },
        { "name": "Backup", "apiKey": "sk-...", "isDefault": false }
      ],
      "models": {
        "claude-opus-4-8": { "realModel": "claude-opus-4-8" }
      }
    }
  },
  "aliases": {
    "gorouter/claude-opus-4-8": { "provider": "gorouter", "model": "claude-opus-4-8" }
  }
}
```

Old configs (with `modelGroups`, per-provider `aliases`, per-model `aliases`, or single `apiKey`) are **auto-migrated** on first load:
- group members `provider:model` → aliases `provider/model`
- per-model aliases → top-level aliases
- `apiKey` → `accounts[0]`
- dangling references pruned

## Dual-Protocol Providers

Some upstreams (seekai.cc, gorouter.app) expose **both** endpoints — `/v1/chat/completions` (OpenAI, `Authorization: Bearer`) and `/v1/messages` (Anthropic, `x-api-key`). For these, set `protocols: ["openai", "anthropic"]`. abproxy then forwards each client request **natively** in the client's own protocol — no lossy translation, so thinking blocks, tool_use, and cache_control survive intact.

## URL Handling

| You enter | abproxy sends to |
|---|---|
| `https://seekai.cc/v1` | `https://seekai.cc/v1/chat/completions` or `.../v1/messages` |
| `https://seekai.cc` | `https://seekai.cc/v1/...` |
| `https://api.anthropic.com` | `https://api.anthropic.com/v1/messages` |

## License

MIT
