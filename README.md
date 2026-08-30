# abproxy

> Local LLM gateway/proxy — one endpoint, many providers, automatic failover.

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
abproxy model list
abproxy start
```

## Features

- **One local endpoint** (`http://localhost:1986`) for all your agents
- **Multi-provider support** — Anthropic-native and OpenAI-compatible APIs
- **Auto model discovery** — fetches available models from provider's `/v1/models` endpoint
- **Same-model failover** — `opus-5` on provider1 rate-limits → auto-retry on provider2
- **Protocol translation** — OpenAI ↔ Anthropic format conversion (request + streaming)
- **Streaming passthrough** — SSE streams piped directly, no buffering
- **Config hot-reload** — edit config while server is running, changes apply instantly
- **Agent setup wrappers** — `abproxy setup claude-code|opencode|codex`
- **Interactive REPL** — Claude-Code-style `/` slash commands

## Works With

abproxy works as a drop-in proxy for any provider that exposes OpenAI-compatible or Anthropic-native APIs:

| Provider | Base URL Pattern | Type |
|---|---|---|
| seekai.cc | `https://seekai.cc/v1` | OpenAI-compatible + Anthropic |
| gorouter.app | `https://gorouter.app/v1` | OpenAI-compatible |
| agentrouter.org | `https://agentrouter.org/v1` | OpenAI-compatible |
| OpenAI | `https://api.openai.com/v1` | OpenAI-compatible |
| Anthropic | `https://api.anthropic.com` | Anthropic-native |
| Any OpenAI-compatible | `https://your-provider.com/v1` | OpenAI-compatible |

### Agent Configuration

```bash
# Claude Code
abproxy setup claude-code

# Codex
abproxy setup codex

# opencode
abproxy setup opencode
```

Or set manually:

```bash
# Claude Code
export ANTHROPIC_BASE_URL=http://localhost:1986
export ANTHROPIC_API_KEY=sk-local-...

# Codex / opencode
# Base URL: http://localhost:1986/v1
# API Key: sk-local-...
```

## Architecture

```
Agents → http://localhost:1986 → abproxy daemon → provider1.com
                                                 → provider2.com
                                                 → provider3.com
```

- **CLI/REPL** — management + interactive mode
- **Daemon** — background HTTP server handling proxy + failover
- **Config** — `~/.abproxy/config.json` (source of truth)

## CLI Commands

### Provider Management
```bash
abproxy provider add              # Interactive setup (auto-fetches models)
abproxy provider list             # Table view
abproxy provider edit <name>      # Edit provider
abproxy provider delete <name>    # Delete + cascade
abproxy provider test <name>      # Live ping test
abproxy provider sync <name>      # Re-fetch models from upstream
```

### Model Management
```bash
abproxy model add <provider>      # Add model to provider
abproxy model list [--provider p] # List all/filtered models
abproxy model edit <p> <m>        # Edit model
abproxy model delete <p> <m>      # Delete model
abproxy model alias <m> <alias>   # Add alias
abproxy model set-default <m>     # Set default model
abproxy model test <m>            # Live completion test
```

### Model Groups (Failover)
```bash
abproxy group create <name>       # Create failover group
abproxy group edit <name>         # Edit group members
abproxy group list                # List all groups
abproxy group delete <name>       # Delete group
```

### Daemon Control
```bash
abproxy start                     # Start as background daemon
abproxy start --foreground        # Start in foreground
abproxy stop                      # Stop daemon
abproxy restart                   # Restart daemon
abproxy status                    # Check daemon status + health
abproxy logs [-f]                 # View/follow logs
```

### Agent Setup
```bash
abproxy setup claude-code         # Patch Claude Code config
abproxy setup opencode            # Patch opencode config
abproxy setup codex               # Patch codex config
```

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check + provider status |
| `GET /v1/models` | List all available models (names + aliases + realModel IDs) |
| `GET /v1/models/:id` | Get a single model by ID |
| `POST /v1/chat/completions` | OpenAI-compatible completions |
| `POST /v1/messages` | Anthropic-native messages |

All endpoints (except `/health`) require `Authorization: Bearer <localApiKey>` or `x-api-key: <localApiKey>`.

### Model Discovery

When you add a provider, abproxy automatically fetches available models from the provider's `/v1/models` endpoint. You can re-sync models at any time:

```bash
abproxy provider sync myProvider
```

The `/v1/models` endpoint on abproxy itself lists every configured model by:
- Its **model name** (your custom alias like `opus-5`)
- Its **model aliases** (all aliases)
- Its **realModel** ID (the upstream API model ID)
- **Model groups** (virtual failover names)

This ensures agents like Claude Code, Codex, or opencode can find the model regardless of which name they use.

## Config Example

```json
{
  "port": 1986,
  "localApiKey": "sk-local-...",
  "defaultModel": "opus-5",
  "providers": {
    "seekai": {
      "aliases": ["sk"],
      "type": "openai-compatible",
      "baseURL": "https://seekai.cc/v1",
      "apiKey": "sk-your-key",
      "autoFetch": true,
      "models": {
        "claude-opus-4-8": {
          "realModel": "claude-opus-4-8",
          "aliases": ["opus"]
        },
        "glm-5.3-flash": {
          "realModel": "glm-5.3-flash",
          "aliases": ["glm"]
        }
      }
    },
    "gorouter": {
      "aliases": ["gr"],
      "type": "openai-compatible",
      "baseURL": "https://gorouter.app/v1",
      "apiKey": "sk-your-key",
      "autoFetch": true,
      "models": {
        "claude-opus-5-thinking": {
          "realModel": "claude-opus-5-thinking",
          "aliases": []
        }
      }
    }
  },
  "modelGroups": {
    "opus": {
      "members": ["seekai:claude-opus-4-8", "gorouter:claude-opus-5-thinking"],
      "strategy": "failover"
    }
  }
}
```

## URL Handling

abproxy handles different provider URL patterns automatically:

| You enter | abproxy sends to |
|---|---|
| `https://seekai.cc/v1` | `https://seekai.cc/v1/chat/completions` |
| `https://seekai.cc` | `https://seekai.cc/v1/chat/completions` |
| `https://api.openai.com/v1` | `https://api.openai.com/v1/chat/completions` |
| `https://api.anthropic.com` | `https://api.anthropic.com/v1/messages` |

No need to worry about trailing slashes or `/v1` — abproxy normalizes everything.

## License

MIT
