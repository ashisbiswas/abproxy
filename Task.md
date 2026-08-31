# Tasks

## Phase 1: Config Layer (Multi-Account Foundation)
- [ ] Update `schema.js` — add account validation, update provider validator
- [ ] Update `manager.js` — auto-migration, account CRUD, `getActiveApiKey()` helper
- [ ] Update `adapters.js` — use `getActiveApiKey()` instead of `provider.apiKey`
- [ ] Update `testing.js` — use `getActiveApiKey()`
- [ ] Update `models-fetcher.js` — use `getActiveApiKey()` or accept key from caller

## Phase 2: REPL Menu Restructuring
- [ ] Rewrite `commands.js` — hierarchical sub-menus with main/provider/model/group/account menus
- [ ] Update `index.js` — point to new `showMainMenu`

## Phase 3: Verification
- [ ] Launch REPL and test menu navigation
- [ ] Test config auto-migration from old format
