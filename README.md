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
- **Multi-account providers** — several API keys per provider, one active
- **Automatic account rotation** — quota exhausted → next account, transparently
- **Default provider + per-provider default model** — `default` just works
- **Auto model discovery** — fetches available models from provider's `/v1/models`
- **Config hot-reload** — edit config while server runs, changes apply instantly
- **Agent setup wrappers** — `abproxy setup claude-code|opencode|codex`

## Agent Configuration

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
