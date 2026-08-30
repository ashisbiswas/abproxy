# abproxy — Workflow & Architecture

A local Node.js LLM gateway/proxy with a Claude-Code-style CLI. Point every agent (Claude Code, opencode, codex, your own apps) at one stable `http://localhost:1986` endpoint, and swap real providers/models/keys behind it without touching agent configs.

---

## 1. Goals (recap)

- One local base URL + one dummy local API key for every client.
- Real provider base URLs, keys, and model names live only in `abproxy`'s config.
- A provider can expose **multiple models**.
- Providers, models, and model names can each have **aliases**.
- Full CRUD: add / edit / delete provider, add / edit / delete model.
- **Test** a provider or model (live ping).
- **Default model** selection.
- **Same-model, multi-provider failover** — e.g. `opus-5` exists on provider1 and provider2; if provider1 rate-limits, requests automatically retry on provider2.
- Claude-Code-style interactive CLI with `/` slash-command menu.
- **Setup wrappers** for Claude Code, opencode, codex — one command each, no manual per-agent base URL editing ever again.

---

## 2. High-level architecture

```
┌───────────────────────────────────────────────┐
│                 abproxy CLI                     │
│   management commands + interactive REPL (/)    │
└───────────────────┬─────────────────────────────┘
                     │ reads/writes
                     ▼
        ~/.abproxy/config.json   (source of truth)
                     │ read by
                     ▼
┌───────────────────────────────────────────────┐
│               abproxy daemon (server)           │
│         http://localhost:1986                   │
│  /v1/chat/completions   (OpenAI-compatible)      │
│  /v1/messages           (Anthropic-native)       │
│  /v1/models                                      │
│  resolves alias → model group → provider          │
│  failover on 429 / 5xx / timeout                  │
└───────────────────┬─────────────────────────────┘
                     │ forwards
                     ▼
        provider1.com   provider2.com   provider3.com
```

Two processes, one config file:
- **CLI** = human-facing management + REPL.
- **Daemon** = long-running background server that agents actually talk to.

---

## 3. Config schema (`~/.abproxy/config.json`)

```json
{
  "port": 1986,
  "localApiKey": "sk-local-xxxxxxxx",
  "defaultModel": "opus-5",

  "providers": {
    "provider1": {
      "aliases": ["p1", "chutes"],
      "type": "anthropic-native",
      "baseURL": "https://provider1.example.com",
      "apiKey": "sk-real-key-1",
      "models": {
        "opus-5": {
          "realModel": "claude-opus-4-1-20250805",
          "aliases": ["opus", "claude-opus-4-5-20250929"]
        }
      }
    },
    "provider2": {
      "aliases": ["p2"],
      "type": "anthropic-native",
      "baseURL": "https://provider2.example.com",
      "apiKey": "sk-real-key-2",
      "models": {
        "opus-5": { "realModel": "opus-4.1", "aliases": [] }
      }
    },
    "provider3": {
      "aliases": ["p3", "glm-provider"],
      "type": "openai-compatible",
      "baseURL": "https://provider3.example.com/v1",
      "apiKey": "sk-real-key-3",
      "models": {
        "glm-air": { "realModel": "glm-4-air", "aliases": ["glm"] }
      }
    }
  },

  "modelGroups": {
    "opus-5": {
      "members": ["provider1:opus-5", "provider2:opus-5"],
      "strategy": "failover",
      "default": true
    }
  }
}
```

**Key concept — model group.** A virtual model name (e.g. `opus-5`) maps to a group. A group can list the *same logical model* across *multiple providers*. This is what makes "same model, different provider, auto-switch on rate limit" work with no extra config concept.

---

## 4. CLI command reference

### Provider management
```
abproxy provider add
abproxy provider list
abproxy provider edit <name>
abproxy provider delete <name>
abproxy provider test <name>
```

### Model management
```
abproxy model add <provider>
abproxy model list [--provider <name>]
abproxy model edit <provider> <model>
abproxy model delete <provider> <model>
abproxy model alias <model> <newAlias>
abproxy model set-default <model>
abproxy model test <model>
```

### Model groups (failover sets)
```
abproxy group create <name> --members provider1:opus-5,provider2:opus-5
abproxy group edit <name>
abproxy group list
```

### Agent setup wrappers
```
abproxy setup claude-code
abproxy setup opencode
abproxy setup codex
```

### Daemon control
```
abproxy start
abproxy stop
abproxy restart
abproxy status
abproxy logs [--follow]
```

`add` / `edit` with no flags → guided interactive prompts (baseURL, key, type, then loop "add another model? y/n").

---

## 5. Interactive REPL (`abproxy` with no args)

Claude-Code-styled: boxed banner on launch, persistent prompt, `/` slash menu.

```
/providers                 list providers (table)
/provider add
/provider edit <name>
/provider delete <name>
/provider test <name>

/models [provider]
/model add <provider>
/model alias <model> <alias>
/model default <model>
/model test <model>

/groups
/group add

/setup <claude-code|opencode|codex>
/status                    server state, uptime, request count, per-provider health
/logs
/help
/exit
```

Typing `/` alone opens a fuzzy-filterable command menu, same UX pattern as Claude Code.

**Suggested stack for the "stylish" feel:**
| Purpose | Package |
|---|---|
| Live boxed UI, React-for-CLI | `ink` |
| Colors / banner | `chalk`, `gradient-string` |
| Tables | `cli-table3` |
| Spinners during tests | `ora` |
| Guided add/edit prompts | `@inquirer/prompts` |
| Slash-command fuzzy menu | `enquirer` or custom Ink component |

---

## 6. Request flow (daemon)

1. Client (Claude Code, opencode, codex, curl, your app) sends an OpenAI- or Anthropic-shaped request to `http://localhost:1986/...` with `Authorization: Bearer <localApiKey>` and a `model` field (real name or any alias).
2. **Auth check** — reject anything not matching `localApiKey`.
3. **Alias resolution** — model name/alias → model group.
4. **Group resolution** — ordered member list, e.g. `[provider1:opus-5, provider2:opus-5]`.
5. **Adapter translation** — request body/headers rewritten to match that provider's `type` (`anthropic-native` vs `openai-compatible`).
6. **Forward** — call real `baseURL` with real `apiKey` and real `realModel`.
7. **Streaming passthrough** — if `stream: true`, pipe upstream SSE chunks straight to the client response, no buffering.
8. **Failover** — on `429` / `5xx` / timeout / connection error: log the failure, advance to the next group member, retry the same (translated) request. First success wins.
9. **Exhaustion** — if every member fails, return one clear error summarizing what was tried and why each failed.
10. **Response normalization** — client always sees the shape it expects (OpenAI-style out of `/v1/chat/completions`, Anthropic-style out of `/v1/messages`) regardless of which upstream actually served it.

### Failure tracking
- In-memory per-provider failure timestamps.
- `/status` shows e.g. `provider1: rate-limited, cooling down ~40s`.
- Optional: skip a provider proactively if it failed within the last N seconds instead of always trying it first in the chain.

---

## 7. Agent setup wrappers — how each one is patched

| Tool | Where it reads endpoint config | What `abproxy setup <tool>` does |
|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` env vars, or `~/.claude/settings.json` | Merge-patch `ANTHROPIC_BASE_URL=http://localhost:1986` + local dummy key into settings.json (or print shell export lines) |
| **opencode** | `opencode.json`, `provider` block with per-provider `baseURL` | Merge-patch a provider entry pointed at abproxy's OpenAI-compatible route |
| **codex** | `~/.codex/config.toml`, `[model_providers.*]` with `base_url` | Merge-patch that TOML block |

Rule for all wrappers: **merge, never overwrite** the whole file — touch only the keys abproxy owns.

---

## 8. Build phases

1. **Phase 1 — Config CRUD.** Schema + `provider add/list/edit/delete`, `model add/list/edit/delete`, aliases. Non-interactive CLI only, no server.
2. **Phase 2 — Core proxy.** Single-provider passthrough, OpenAI-compatible + Anthropic-native adapters, streaming, no groups/failover yet.
3. **Phase 3 — Groups & failover.** Model groups, ordered failover, `/status` health visibility.
4. **Phase 4 — Agent wrappers.** `setup claude-code`, `setup opencode`, `setup codex`.
5. **Phase 5 — Polish.** Ink-based REPL, slash-command menu, banner, tables, spinners, `logs --follow`.

---

## 9. Additional ideas worth considering

- **Usage/cost tracking per provider** — log request count, token count (from response usage fields), and rough cost estimate per provider/model, viewable via `abproxy stats`. Useful for knowing which free tiers are close to exhausted.
- **Health-check daemon loop** — periodically ping each provider (or just track from real traffic) and mark providers "degraded" before a real request fails, so failover can skip them proactively rather than reactively.
- **Round-robin / weighted strategy option** — beyond `failover`, support `strategy: "round-robin"` on a group to spread load across free-tier limits instead of always hammering the first provider.
- **Config hot-reload** — watch `config.json` for changes and reload the model index without restarting the daemon (important since you'll be editing config constantly while an agent session is live).
- **Request logging/replay** — store last N requests/responses (redacted of keys) to `~/.abproxy/logs/`, useful for debugging "why did this agent call fail."
- **`.env`-free key storage option** — optionally support OS keychain storage (`keytar`) for provider API keys instead of plaintext JSON, since these are real (if free-tier) credentials.
- **Per-model context-window / pricing metadata** — store `contextWindow` and `notes` fields per model so `/model list` can show useful info at a glance, not just names.
- **"Dry-run" test mode** — `abproxy provider test <name> --dry-run` just validates the URL/key/handshake without spending a real token on a completion call, since free-tier quotas are often precious.
- **Multiple local API keys** — support several `localApiKey`s mapped to different default-model-groups, so e.g. Claude Code uses one key/group and opencode uses another, without editing config each time you switch tools.
- **Shell completion** — generate bash/zsh completion for `abproxy` subcommands, matching the "feels like a real CLI tool" goal.
- **`abproxy doctor`** — one command that checks: is the daemon running, is the port free, are all configured providers reachable, is at least one model group valid — good first troubleshooting step à la `npm doctor` / `flutter doctor`.

---

## 10. Next step

Ready to scaffold **Phase 1** (project structure + config CRUD, non-interactive CLI) as actual code whenever you want to start.
