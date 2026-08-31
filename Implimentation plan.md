# Restructure REPL Menu & Add Multi-Account Provider Support

Two major changes: (1) Reorganize the flat REPL command list into a hierarchical sub-menu system, and (2) Add multi-account support so a single provider can hold multiple API keys (accounts).

## User Review Required

> [!IMPORTANT]
> **Config Migration**: The provider schema changes from a single `apiKey` field to an `accounts` array. Existing configs will be auto-migrated on first load (the old `apiKey` moves into `accounts[0]` as the default account). This is a **backward-compatible** change — the proxy server and all commands will use the `defaultAccount`'s API key automatically.

> [!WARNING]
> **Breaking**: After migration, the config.json structure will change. Rolling back would require manually editing config.json.

## Open Questions

> [!IMPORTANT]  
> **Account rotation for failover**: When a request fails on one account, should the failover engine automatically try the next account on the same provider before moving to a different provider? Or should accounts only be manually switchable? (Current plan: manual switching only, failover stays at the provider level.)

> [!IMPORTANT]
> **Delete model flow**: You said "first provider will show and select the model to delete." Should the delete model menu show ALL models across all providers in one flat list (with provider name shown), or should it first ask you to pick a provider, then show only that provider's models?  
> (Current plan: first pick provider → then pick model from that provider.)

## Proposed Changes

### 1. REPL Menu Restructuring

---

#### [MODIFY] [commands.js](file:///e:/projects/abproxy/src/repl/commands.js)

**Complete rewrite** of the command system. Replace the flat `commands` array with a hierarchical menu:

**Main Menu** (shown when pressing `/`):
| Menu Item | Description |
|-----------|-------------|
| `/providers` | Manage providers → opens provider sub-menu |
| `/models` | Manage models → opens model sub-menu |
| `/groups` | Manage model groups → opens group sub-menu |
| `/setup` | Configure agents (Claude Code, opencode, codex) |
| `/config` | Show config file path and API key |
| `/help` | Full reference + server/daemon commands |
| `/exit` | Exit abproxy |

**Provider Sub-Menu** (`/providers`):
| Item | Handler |
|------|---------|
| List Providers | Show providers table |
| Add Provider | Interactive add (with multi-account) |
| Edit Provider | Select → edit type/baseURL/aliases |
| Delete Provider | Select → confirm → delete |
| Test Provider | Select → ping test |
| Sync Models | Select → fetch/import models |
| Manage Accounts | → account sub-menu |
| ← Back | Return to main menu |

**Account Sub-Menu** (inside providers):
| Item | Handler |
|------|---------|
| List Accounts | Show accounts table for a provider |
| Add Account | Select provider → add name + API key |
| Edit Account | Select provider → account → edit |
| Delete Account | Select provider → account → delete |
| Set Default Account | Select provider → pick default |
| ← Back | Return to provider menu |

**Model Sub-Menu** (`/models`):
| Item | Handler |
|------|---------|
| List Models | Show models table |
| Add Model | Select provider → add model |
| Delete Model | Select provider → select model → confirm |
| Add Alias | Select model → add alias |
| Set Default Model | Select model as default |
| Test Model | Select model → ping test |
| ← Back | Return to main menu |

**Group Sub-Menu** (`/groups`):
| Item | Handler |
|------|---------|
| List Groups | Show groups table |
| Add Group | Create group with members + strategy |
| Edit Group | Select → modify members/strategy |
| Delete Group | Select → confirm → delete |
| ← Back | Return to main menu |

**Help** (`/help`):
Comprehensive help showing all categories including daemon/server commands:
- Provider commands
- Model commands
- Group commands
- Server commands (`abproxy start`, `stop`, `restart`, `status`, `logs`)
- Setup commands
- Keyboard shortcuts

---

#### [MODIFY] [index.js](file:///e:/projects/abproxy/src/repl/index.js)

Minor changes: update `showCommandPicker` reference to the new `showMainMenu` function. The raw-mode keypress logic stays the same.

---

### 2. Multi-Account Provider Support

---

#### [MODIFY] [schema.js](file:///e:/projects/abproxy/src/config/schema.js)

Update provider schema — the `apiKey` field becomes optional (kept for backward compat). New `accounts` array:

```js
// New provider structure:
{
  type: 'anthropic-native',
  baseURL: 'https://gorouter.app',
  aliases: [],
  models: {},
  autoFetch: true,
  // NEW: Multi-account support
  accounts: [
    { name: 'Main Account', apiKey: 'sk-xxx', isDefault: true },
    { name: 'Backup Account', apiKey: 'sk-yyy', isDefault: false },
  ],
  // DEPRECATED but auto-migrated: apiKey: 'sk-xxx'
}
```

Add `validateProvider` updates and a new `validateAccount` function.

---

#### [MODIFY] [manager.js](file:///e:/projects/abproxy/src/config/manager.js)

- **Config migration**: `getConfig()` auto-migrates old `apiKey` → `accounts[0]` on read.
- **New CRUD functions**: `addAccount()`, `editAccount()`, `deleteAccount()`, `setDefaultAccount()`, `listAccounts()`.
- **Helper**: `getActiveApiKey(provider)` — returns the default account's API key.
- **Update** `addProvider()` — collect first account during provider creation instead of single apiKey.

---

#### [MODIFY] [adapters.js](file:///e:/projects/abproxy/src/server/adapters.js)

Update `buildUpstreamHeaders()` — instead of reading `provider.apiKey` directly, call `getActiveApiKey(provider)` to get the default account's key.

---

#### [MODIFY] [testing.js](file:///e:/projects/abproxy/src/utils/testing.js)

Update `testModel()` — use `getActiveApiKey(provider)` instead of `provider.apiKey` when building headers.

---

#### [MODIFY] [models-fetcher.js](file:///e:/projects/abproxy/src/server/models-fetcher.js)

Update to use `getActiveApiKey()` or accept the API key from the caller (for cases where we fetch during provider add before saving to config).

---

### 3. Files Unchanged

These files need no modifications:
- [banner.js](file:///e:/projects/abproxy/src/repl/banner.js) — no changes
- [proxy.js](file:///e:/projects/abproxy/src/server/proxy.js) — no changes (uses adapters)
- [resolver.js](file:///e:/projects/abproxy/src/server/resolver.js) — no changes
- [failover.js](file:///e:/projects/abproxy/src/server/failover.js) — no changes (uses adapters)
- [abproxy.js](file:///e:/projects/abproxy/bin/abproxy.js) — no changes
- CLI files under `src/cli/` — these are only used for direct CLI invocation (`abproxy provider add` etc.), not the REPL. They will continue to work but won't get multi-account features immediately (REPL is the primary interface).

## Verification Plan

### Manual Verification
1. Launch `abproxy` → verify main menu shows 7 items
2. Navigate `/providers` → verify sub-menu with 7 items + back
3. Add a provider → verify account prompt flow (name + API key)
4. Add a second account → verify it appears in account list
5. Switch default account → verify test uses the new key
6. Navigate `/models` → verify sub-menu, especially delete model flow (provider first → model second)
7. Navigate `/groups` → verify sub-menu
8. Check `/help` → verify daemon/server commands are documented
9. Verify existing config auto-migrates (old `apiKey` → `accounts[0]`)
10. Run `provider test` → verify it uses the default account's API key
