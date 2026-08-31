import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { input, select, confirm, checkbox } from '@inquirer/prompts';
import {
  addProvider,
  editProvider,
  deleteProvider,
  listProviders,
  addAccount,
  editAccount,
  deleteAccount,
  setDefaultAccount,
  listAccounts,
  getActiveApiKey,
  getActiveAccountName,
  addModel,
  deleteModel,
  addModelAlias,
  setDefaultModel,
  listModels,
  addGroup,
  editGroup,
  deleteGroup,
  listGroups,
  getConfig,
  resolveProviderName,
  importFetchedModels,
  syncProviderModels,
} from '../config/manager.js';
import { testProvider, testModel, formatTestResult } from '../utils/testing.js';
import { fetchProviderModels } from '../server/models-fetcher.js';

const BACK = Symbol('back');
const backChoice = { name: chalk.gray('← Back'), value: BACK };

// ─── Shared Helpers ──────────────────────────────────────────────────

/**
 * Mask an API key for display: sk-abc...wxyz
 */
function maskKey(key) {
  if (!key) return chalk.gray('—');
  if (key.length <= 12) return `${key.slice(0, 3)}${'*'.repeat(Math.max(key.length - 3, 0))}`;
  return `${key.slice(0, 6)}${'*'.repeat(6)}${key.slice(-4)}`;
}

/**
 * Prompt for a provider. Returns the resolved provider name, or BACK.
 */
async function pickProvider(message = 'Select provider:') {
  const providers = Object.keys(listProviders());
  if (providers.length === 0) {
    console.log(chalk.yellow('\n  No providers configured. Use Providers → Add Provider\n'));
    return BACK;
  }
  return select({
    message,
    choices: [...providers.map(p => ({ name: p, value: p })), backChoice],
    loop: false,
  });
}

/**
 * Prompt for an account on a provider. Returns the account name, or BACK.
 */
async function pickAccount(providerName, message = 'Select account:') {
  const accounts = listAccounts(providerName);
  if (accounts.length === 0) {
    console.log(chalk.yellow(`\n  Provider "${providerName}" has no accounts. Use Add Account\n`));
    return BACK;
  }
  return select({
    message,
    choices: [
      ...accounts.map(a => ({
        name: `${a.name}${a.isDefault ? chalk.green(' ★ default') : ''}  ${chalk.gray(maskKey(a.apiKey))}`,
        value: a.name,
      })),
      backChoice,
    ],
    loop: false,
  });
}

/**
 * Prompt for a model belonging to a specific provider. Returns model name, or BACK.
 */
async function pickModelOfProvider(providerName, message = 'Select model:') {
  const models = listModels(providerName);
  if (models.length === 0) {
    console.log(chalk.yellow(`\n  Provider "${providerName}" has no models.\n`));
    return BACK;
  }
  return select({
    message,
    choices: [
      ...models.map(m => ({
        name: `${m.name} ${chalk.gray(`→ ${m.realModel}`)}${m.isDefault ? chalk.green(' ★') : ''}`,
        value: m.name,
      })),
      backChoice,
    ],
    loop: false,
    pageSize: 20,
  });
}

/**
 * Parse a comma-separated list into a trimmed array.
 */
function parseList(str) {
  return str ? str.split(',').map(s => s.trim()).filter(Boolean) : [];
}

/**
 * Run a handler and swallow prompt-cancellation errors so the REPL survives.
 */
async function guard(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

// ─── Command Registry (typed commands) ───────────────────────────────

/**
 * Typed slash commands. The interactive `/` picker uses `showMainMenu()`
 * below, which exposes the hierarchical menu.
 */
export const commands = [
  { name: '/providers', desc: 'Manage providers (list/add/edit/delete/test/sync/accounts)', handler: showProviderMenu },
  { name: '/models',    desc: 'Manage models (list/add/delete/alias/default/test)',         handler: showModelMenu },
  { name: '/groups',    desc: 'Manage model groups (list/add/edit/delete)',                 handler: showGroupMenu },
  { name: '/setup',     desc: 'Configure an agent (claude-code|opencode|codex)',            handler: cmdSetup },
  { name: '/status',    desc: 'Server state and health',                                    handler: cmdStatus },
  { name: '/config',    desc: 'Show config file path and local API key',                    handler: cmdConfig },
  { name: '/help',      desc: 'Full command reference',                                     handler: cmdHelp },
  { name: '/exit',      desc: 'Exit abproxy',                                               handler: cmdExit },
];

/**
 * Match a user input to a command
 */
export function matchCommand(input) {
  const trimmed = input.trim();
  // Exact match first
  const exact = commands.find(c => trimmed === c.name || trimmed.startsWith(c.name + ' '));
  if (exact) {
    const args = trimmed.slice(exact.name.length).trim();
    return { command: exact, args };
  }
  // Fuzzy: find commands that start with the input
  const partial = commands.filter(c => c.name.startsWith(trimmed));
  if (partial.length === 1) {
    return { command: partial[0], args: '' };
  }
  return null;
}

// ─── Main Menu ───────────────────────────────────────────────────────

/**
 * Top-level menu shown when the user presses `/`.
 */
export async function showMainMenu() {
  try {
    const choice = await select({
      message: 'abproxy menu:',
      choices: [
        { name: `${chalk.cyan('Providers'.padEnd(12))} ${chalk.gray('Add, edit, test providers & accounts')}`, value: 'providers' },
        { name: `${chalk.cyan('Models'.padEnd(12))} ${chalk.gray('Add, delete, alias, test models')}`,        value: 'models' },
        { name: `${chalk.cyan('Groups'.padEnd(12))} ${chalk.gray('Model groups for failover')}`,              value: 'groups' },
        { name: `${chalk.cyan('Setup'.padEnd(12))} ${chalk.gray('Configure Claude Code / opencode / codex')}`, value: 'setup' },
        { name: `${chalk.cyan('Config'.padEnd(12))} ${chalk.gray('Config path and local API key')}`,          value: 'config' },
        { name: `${chalk.cyan('Help'.padEnd(12))} ${chalk.gray('Full command reference')}`,                   value: 'help' },
        { name: `${chalk.cyan('Exit'.padEnd(12))} ${chalk.gray('Quit abproxy')}`,                             value: 'exit' },
        backChoice,
      ],
      loop: false,
      pageSize: 8,
    });

    switch (choice) {
      case 'providers': return showProviderMenu();
      case 'models':    return showModelMenu();
      case 'groups':    return showGroupMenu();
      case 'setup':     return cmdSetup('');
      case 'config':    return cmdConfig();
      case 'help':      return cmdHelp();
      case 'exit':      return cmdExit();
      default:          return;
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

/**
 * Backwards-compatible alias — the REPL previously called this name.
 */
export const showCommandPicker = showMainMenu;

// ─── Provider Menu ───────────────────────────────────────────────────

export async function showProviderMenu() {
  try {
    const choice = await select({
      message: 'Providers:',
      choices: [
        { name: `${chalk.cyan('List Providers'.padEnd(20))} ${chalk.gray('Show providers table')}`,       value: 'list' },
        { name: `${chalk.cyan('Add Provider'.padEnd(20))} ${chalk.gray('Interactive setup + accounts')}`, value: 'add' },
        { name: `${chalk.cyan('Edit Provider'.padEnd(20))} ${chalk.gray('Type, base URL, aliases')}`,     value: 'edit' },
        { name: `${chalk.cyan('Delete Provider'.padEnd(20))} ${chalk.gray('Remove provider + models')}`,  value: 'delete' },
        { name: `${chalk.cyan('Test Provider'.padEnd(20))} ${chalk.gray('Live ping test')}`,              value: 'test' },
        { name: `${chalk.cyan('Sync Models'.padEnd(20))} ${chalk.gray('Fetch models from upstream')}`,    value: 'sync' },
        { name: `${chalk.cyan('Manage Accounts'.padEnd(20))} ${chalk.gray('Multiple API keys per provider')}`, value: 'accounts' },
        backChoice,
      ],
      loop: false,
      pageSize: 8,
    });

    switch (choice) {
      case 'list':     await cmdProviderList(); break;
      case 'add':      await cmdProviderAdd(); break;
      case 'edit':     await cmdProviderEdit(); break;
      case 'delete':   await cmdProviderDelete(); break;
      case 'test':     await cmdProviderTest(); break;
      case 'sync':     await cmdProviderSync(); break;
      case 'accounts': await showAccountMenu(); break;
      default: return;
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdProviderList() {
  const providers = listProviders();
  const entries = Object.entries(providers);
  if (entries.length === 0) {
    console.log(chalk.yellow('\n  No providers configured. Use Providers → Add Provider\n'));
    return;
  }
  const table = new Table({
    head: [
      chalk.cyan('Name'),
      chalk.cyan('Type'),
      chalk.cyan('Base URL'),
      chalk.cyan('Aliases'),
      chalk.cyan('Models'),
      chalk.cyan('Accounts'),
      chalk.cyan('Active Account'),
    ],
    style: { head: [], border: ['gray'] },
  });
  for (const [name, p] of entries) {
    const accountCount = (p.accounts || []).length;
    table.push([
      chalk.white.bold(name),
      p.type === 'anthropic-native' ? chalk.magenta(p.type) : chalk.blue(p.type),
      chalk.gray(p.baseURL),
      (p.aliases || []).join(', ') || chalk.gray('—'),
      chalk.yellow(Object.keys(p.models || {}).length.toString()),
      chalk.yellow(accountCount.toString()),
      accountCount > 0 ? chalk.green(getActiveAccountName(p)) : chalk.gray('—'),
    ]);
  }
  console.log('\n' + table.toString() + '\n');
}



async function cmdProviderAdd() {
  return guard(async () => {
    const name = await input({ message: 'Provider name:' });
    if (!name.trim()) { console.log(chalk.gray('  Cancelled — name is required.')); return; }

    const type = await select({
      message: 'Provider type:',
      choices: [
        { name: 'Anthropic Native', value: 'anthropic-native' },
        { name: 'OpenAI Compatible', value: 'openai-compatible' },
      ],
    });
    const baseURL = await input({ message: 'Base URL:' });

    // ── Collect one or more accounts ─────────────────────────────
    const accounts = [];
    let addAnother = true;
    while (addAnother) {
      const accName = await input({
        message: 'Account name:',
        default: accounts.length === 0 ? 'Default' : `Account ${accounts.length + 1}`,
      });
      const accKey = await input({ message: `  API key for "${accName}":` });
      if (!accKey.trim()) {
        console.log(chalk.yellow('  ⚠ Skipped — API key cannot be empty.'));
      } else if (accounts.some(a => a.name === accName)) {
        console.log(chalk.yellow(`  ⚠ Skipped — account "${accName}" already added.`));
      } else {
        accounts.push({ name: accName, apiKey: accKey, isDefault: accounts.length === 0 });
        console.log(chalk.green(`  ✔ Account "${accName}" added`));
      }
      addAnother = await confirm({ message: 'Add another account?', default: false });
    }

    if (accounts.length === 0) {
      console.log(chalk.red('  ✖ At least one account with an API key is required.'));
      return;
    }

    // If more than one account, let the user pick the default
    if (accounts.length > 1) {
      const defaultName = await select({
        message: 'Which account should be the default?',
        choices: accounts.map(a => ({ name: a.name, value: a.name })),
        loop: false,
      });
      for (const a of accounts) a.isDefault = a.name === defaultName;
    }

    const aliases = parseList(await input({ message: 'Aliases (comma-separated, or blank):' }));
    const providerData = { type, baseURL, aliases, accounts, models: {}, autoFetch: true };

    // ── Auto-fetch models using the default account's key ────────
    const spinner = ora('Fetching available models from provider...').start();
    const fetchedModels = await fetchProviderModels(
      { type, baseURL, accounts },
      { providerName: name, skipCache: true }
    );
    spinner.stop();

    if (fetchedModels.length > 0) {
      console.log(chalk.green(`  ✔ Found ${fetchedModels.length} model(s)\n`));
      const selectedIds = await checkbox({
        message: 'Select models to import:',
        choices: fetchedModels.map(m => ({ name: m.id, value: m.id, checked: true })),
        pageSize: 20,
      });
      for (const id of selectedIds) {
        providerData.models[id] = { realModel: id, aliases: [] };
      }
      if (selectedIds.length > 0) {
        console.log(chalk.gray(`  Imported ${selectedIds.length} model(s)`));
      }
    } else {
      console.log(chalk.yellow('  ⚠ Could not fetch models (endpoint may not support /v1/models)'));
      let addMore = await confirm({ message: 'Add a model manually?', default: true });
      while (addMore) {
        const modelName = await input({ message: '  Model name:' });
        const realModel = await input({ message: '  Real model name:' });
        const mAliases = parseList(await input({ message: '  Model aliases (or blank):' }));
        providerData.models[modelName] = { realModel, aliases: mAliases };
        addMore = await confirm({ message: 'Add another model?', default: false });
      }
    }

    addProvider(name, providerData);
    const mc = Object.keys(providerData.models).length;
    console.log(chalk.green(
      `\n  ✔ Provider "${name}" added ` +
      `(${accounts.length} account${accounts.length !== 1 ? 's' : ''}, ${mc} model${mc !== 1 ? 's' : ''})\n`
    ));
  });
}


async function cmdProviderEdit() {
  return guard(async () => {
    const name = await pickProvider('Select provider to edit:');
    if (name === BACK) return;

    const config = getConfig();
    const resolved = resolveProviderName(config, name);
    if (!resolved) { console.error(chalk.red(`  ✖ Not found: "${name}"`)); return; }
    const existing = config.providers[resolved];

    const type = await select({
      message: 'Type:',
      default: existing.type,
      choices: [
        { name: 'Anthropic Native', value: 'anthropic-native' },
        { name: 'OpenAI Compatible', value: 'openai-compatible' },
      ],
    });
    const baseURL = await input({ message: 'Base URL:', default: existing.baseURL });
    const aliases = parseList(await input({
      message: 'Aliases:',
      default: (existing.aliases || []).join(', '),
    }));

    editProvider(resolved, { type, baseURL, aliases });
    console.log(chalk.green(`\n  ✔ Provider "${resolved}" updated`));
    console.log(chalk.gray('  API keys are managed under Providers → Manage Accounts\n'));
  });
}

async function cmdProviderDelete() {
  return guard(async () => {
    const name = await pickProvider('Select provider to delete:');
    if (name === BACK) return;

    const yes = await confirm({
      message: `Delete "${name}" and all its models/accounts?`,
      default: false,
    });
    if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }
    deleteProvider(name);
    console.log(chalk.green(`\n  ✔ Deleted "${name}"\n`));
  });
}

async function cmdProviderTest() {
  return guard(async () => {
    const name = await pickProvider('Select provider to test:');
    if (name === BACK) return;

    const config = getConfig();
    const resolved = resolveProviderName(config, name);
    if (resolved) {
      console.log(chalk.gray(`  Using account: ${getActiveAccountName(config.providers[resolved])}`));
    }

    const spinner = ora(`Testing "${name}"...`).start();
    const result = await testProvider(name);
    spinner.stop();
    console.log(formatTestResult(result));
  });
}

async function cmdProviderSync() {
  return guard(async () => {
    const name = await pickProvider('Select provider to sync:');
    if (name === BACK) return;

    const config = getConfig();
    const resolved = resolveProviderName(config, name);
    if (!resolved) { console.error(chalk.red(`  ✖ Not found: "${name}"`)); return; }

    const spinner = ora(`Fetching models from "${resolved}"...`).start();
    const fetchedModels = await fetchProviderModels(config.providers[resolved], {
      providerName: resolved, skipCache: true,
    });
    spinner.stop();

    if (fetchedModels.length === 0) {
      console.log(chalk.yellow('  ⚠ No models returned from provider'));
      return;
    }

    const diff = syncProviderModels(resolved, fetchedModels);
    console.log(chalk.cyan(`\n  Models from "${resolved}":`));
    console.log(chalk.gray(`    Upstream: ${fetchedModels.length}  |  Configured: ${diff.existing.length}  |  New: ${diff.added.length}`));
    if (diff.stale.length > 0) {
      console.log(chalk.red(`    Stale: ${diff.stale.join(', ')}`));
    }

    if (diff.added.length === 0) {
      console.log(chalk.green('\n  ✔ All models already configured.\n'));
      return;
    }

    const toAdd = await checkbox({
      message: 'Select new models to import:',
      choices: diff.added.map(id => ({ name: id, value: id, checked: true })),
      pageSize: 20,
    });

    if (toAdd.length === 0) { console.log(chalk.gray('  No models selected.')); return; }
    const { added } = importFetchedModels(resolved, toAdd.map(id => ({ id })));
    console.log(chalk.green(`\n  ✔ Imported ${added} model(s) to "${resolved}"\n`));
  });
}


// ─── Account Menu ────────────────────────────────────────────────────

export async function showAccountMenu() {
  try {
    const choice = await select({
      message: 'Accounts:',
      choices: [
        { name: `${chalk.cyan('List Accounts'.padEnd(22))} ${chalk.gray('Show accounts for a provider')}`, value: 'list' },
        { name: `${chalk.cyan('Add Account'.padEnd(22))} ${chalk.gray('Add a name + API key')}`,           value: 'add' },
        { name: `${chalk.cyan('Edit Account'.padEnd(22))} ${chalk.gray('Rename or replace the API key')}`, value: 'edit' },
        { name: `${chalk.cyan('Delete Account'.padEnd(22))} ${chalk.gray('Remove an account')}`,           value: 'delete' },
        { name: `${chalk.cyan('Set Default Account'.padEnd(22))} ${chalk.gray('Choose the active API key')}`, value: 'default' },
        backChoice,
      ],
      loop: false,
      pageSize: 6,
    });

    switch (choice) {
      case 'list':    await cmdAccountList(); break;
      case 'add':     await cmdAccountAdd(); break;
      case 'edit':    await cmdAccountEdit(); break;
      case 'delete':  await cmdAccountDelete(); break;
      case 'default': await cmdAccountSetDefault(); break;
      default: return;
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdAccountList() {
  return guard(async () => {
    const providerName = await pickProvider('Show accounts for provider:');
    if (providerName === BACK) return;

    const accounts = listAccounts(providerName);
    if (accounts.length === 0) {
      console.log(chalk.yellow(`\n  Provider "${providerName}" has no accounts. Use Add Account\n`));
      return;
    }

    const table = new Table({
      head: [chalk.cyan('Account'), chalk.cyan('API Key'), chalk.cyan('Default')],
      style: { head: [], border: ['gray'] },
    });
    for (const a of accounts) {
      table.push([
        chalk.white.bold(a.name),
        chalk.gray(maskKey(a.apiKey)),
        a.isDefault ? chalk.green('★') : chalk.gray('—'),
      ]);
    }
    console.log('\n' + table.toString() + '\n');
  });
}

async function cmdAccountAdd() {
  return guard(async () => {
    const providerName = await pickProvider('Add account to provider:');
    if (providerName === BACK) return;

    const existing = listAccounts(providerName);
    const name = await input({
      message: 'Account name:',
      default: existing.length === 0 ? 'Default' : `Account ${existing.length + 1}`,
    });
    const apiKey = await input({ message: 'API key:' });
    if (!apiKey.trim()) {
      console.log(chalk.red('  ✖ API key cannot be empty.'));
      return;
    }

    let isDefault = existing.length === 0;
    if (existing.length > 0) {
      isDefault = await confirm({ message: 'Make this the default account?', default: false });
    }

    addAccount(providerName, { name, apiKey, isDefault });
    console.log(chalk.green(
      `\n  ✔ Account "${name}" added to "${providerName}"${isDefault ? ' (default)' : ''}\n`
    ));
  });
}

async function cmdAccountEdit() {
  return guard(async () => {
    const providerName = await pickProvider('Edit account on provider:');
    if (providerName === BACK) return;

    const accountName = await pickAccount(providerName, 'Select account to edit:');
    if (accountName === BACK) return;

    const current = listAccounts(providerName).find(a => a.name === accountName);
    const newName = await input({ message: 'Account name:', default: current.name });
    const newKey = await input({ message: 'API key (leave as-is to keep):', default: current.apiKey });

    if (!newKey.trim()) {
      console.log(chalk.red('  ✖ API key cannot be empty.'));
      return;
    }

    editAccount(providerName, accountName, { name: newName, apiKey: newKey });
    console.log(chalk.green(`\n  ✔ Account "${newName}" updated on "${providerName}"\n`));
  });
}

async function cmdAccountDelete() {
  return guard(async () => {
    const providerName = await pickProvider('Delete account from provider:');
    if (providerName === BACK) return;

    const accounts = listAccounts(providerName);
    if (accounts.length === 1) {
      console.log(chalk.yellow(
        `\n  ⚠ "${providerName}" has only one account — deleting it would leave the provider unusable.`
      ));
      const proceed = await confirm({ message: 'Delete anyway?', default: false });
      if (!proceed) { console.log(chalk.gray('  Cancelled.')); return; }
    }

    const accountName = await pickAccount(providerName, 'Select account to delete:');
    if (accountName === BACK) return;

    const yes = await confirm({ message: `Delete account "${accountName}"?`, default: false });
    if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }

    deleteAccount(providerName, accountName);
    const remaining = listAccounts(providerName);
    console.log(chalk.green(`\n  ✔ Account "${accountName}" deleted from "${providerName}"`));
    if (remaining.length > 0) {
      console.log(chalk.gray(`  Active account is now: ${getActiveAccountName({ accounts: remaining })}\n`));
    } else {
      console.log(chalk.yellow('  ⚠ Provider has no accounts left — add one before using it.\n'));
    }
  });
}

async function cmdAccountSetDefault() {
  return guard(async () => {
    const providerName = await pickProvider('Set default account for provider:');
    if (providerName === BACK) return;

    const accountName = await pickAccount(providerName, 'Select the default account:');
    if (accountName === BACK) return;

    setDefaultAccount(providerName, accountName);
    console.log(chalk.green(`\n  ✔ "${accountName}" is now the default account for "${providerName}"\n`));
  });
}


// ─── Model Menu ──────────────────────────────────────────────────────

export async function showModelMenu() {
  try {
    const choice = await select({
      message: 'Models:',
      choices: [
        { name: `${chalk.cyan('List Models'.padEnd(20))} ${chalk.gray('Show models table')}`,               value: 'list' },
        { name: `${chalk.cyan('Add Model'.padEnd(20))} ${chalk.gray('Add a model to a provider')}`,         value: 'add' },
        { name: `${chalk.cyan('Delete Model'.padEnd(20))} ${chalk.gray('Pick provider → model → confirm')}`, value: 'delete' },
        { name: `${chalk.cyan('Add Alias'.padEnd(20))} ${chalk.gray('Add an alias to a model')}`,           value: 'alias' },
        { name: `${chalk.cyan('Set Default Model'.padEnd(20))} ${chalk.gray('Used when no model is given')}`, value: 'default' },
        { name: `${chalk.cyan('Test Model'.padEnd(20))} ${chalk.gray('Live completion test')}`,             value: 'test' },
        backChoice,
      ],
      loop: false,
      pageSize: 7,
    });

    switch (choice) {
      case 'list':    await cmdModelList(); break;
      case 'add':     await cmdModelAdd(); break;
      case 'delete':  await cmdModelDelete(); break;
      case 'alias':   await cmdModelAlias(); break;
      case 'default': await cmdModelDefault(); break;
      case 'test':    await cmdModelTest(); break;
      default: return;
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdModelList(args) {
  const models = listModels(args || null);
  if (models.length === 0) { console.log(chalk.yellow('\n  No models configured.\n')); return; }
  const table = new Table({
    head: [chalk.cyan('Model'), chalk.cyan('Provider'), chalk.cyan('Real Model'), chalk.cyan('Aliases'), chalk.cyan('Default')],
    style: { head: [], border: ['gray'] },
  });
  for (const m of models) {
    table.push([
      chalk.white.bold(m.name),
      chalk.gray(m.provider),
      chalk.blue(m.realModel),
      m.aliases.length > 0 ? m.aliases.join(', ') : chalk.gray('—'),
      m.isDefault ? chalk.green('★') : chalk.gray('—'),
    ]);
  }
  console.log('\n' + table.toString() + '\n');
}

async function cmdModelAdd() {
  return guard(async () => {
    const providerName = await pickProvider('Add model to provider:');
    if (providerName === BACK) return;

    const modelName = await input({ message: 'Model name:' });
    if (!modelName.trim()) { console.log(chalk.gray('  Cancelled — name is required.')); return; }
    const realModel = await input({ message: 'Real model name (upstream API ID):', default: modelName });
    const aliases = parseList(await input({ message: 'Aliases (or blank):' }));

    addModel(providerName, modelName, { realModel, aliases });
    console.log(chalk.green(`\n  ✔ Model "${modelName}" added to "${providerName}"\n`));
  });
}

async function cmdModelDelete() {
  return guard(async () => {
    // Provider first, then model (per plan)
    const providerName = await pickProvider('Delete model from provider:');
    if (providerName === BACK) return;

    const modelName = await pickModelOfProvider(providerName, 'Select model to delete:');
    if (modelName === BACK) return;

    const yes = await confirm({
      message: `Delete model "${modelName}" from "${providerName}"?`,
      default: false,
    });
    if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }

    deleteModel(providerName, modelName);
    console.log(chalk.green(`\n  ✔ Model "${modelName}" deleted from "${providerName}"\n`));
  });
}

async function cmdModelAlias() {
  return guard(async () => {
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }

    const modelName = await select({
      message: 'Model:',
      choices: [
        ...models.map(m => ({ name: `${m.name} ${chalk.gray(`(${m.provider})`)}`, value: m.name })),
        backChoice,
      ],
      loop: false,
      pageSize: 20,
    });
    if (modelName === BACK) return;

    const alias = await input({ message: 'New alias:' });
    if (!alias.trim()) { console.log(chalk.gray('  Cancelled — alias is required.')); return; }

    addModelAlias(modelName, alias);
    console.log(chalk.green(`\n  ✔ Alias "${alias}" added to "${modelName}"\n`));
  });
}

async function cmdModelDefault() {
  return guard(async () => {
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }

    const modelName = await select({
      message: 'Set default model:',
      choices: [
        ...models.map(m => ({
          name: `${m.name} ${chalk.gray(`(${m.provider})`)}${m.isDefault ? chalk.green(' ★ current') : ''}`,
          value: m.name,
        })),
        backChoice,
      ],
      loop: false,
      pageSize: 20,
    });
    if (modelName === BACK) return;

    setDefaultModel(modelName);
    console.log(chalk.green(`\n  ✔ Default model: "${modelName}"\n`));
  });
}

async function cmdModelTest() {
  return guard(async () => {
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }

    const modelRef = await select({
      message: 'Model to test:',
      choices: [
        ...models.map(m => ({
          name: `${m.name} ${chalk.gray(`(${m.provider})`)}`,
          value: `${m.provider}:${m.name}`,
        })),
        backChoice,
      ],
      loop: false,
      pageSize: 20,
    });
    if (modelRef === BACK) return;

    const spinner = ora(`Testing "${modelRef}"...`).start();
    const result = await testModel(modelRef);
    spinner.stop();
    console.log(formatTestResult(result));
  });
}


// ─── Group Menu ──────────────────────────────────────────────────────

export async function showGroupMenu() {
  try {
    const choice = await select({
      message: 'Model groups:',
      choices: [
        { name: `${chalk.cyan('List Groups'.padEnd(16))} ${chalk.gray('Show groups table')}`,             value: 'list' },
        { name: `${chalk.cyan('Add Group'.padEnd(16))} ${chalk.gray('Create a failover group')}`,         value: 'add' },
        { name: `${chalk.cyan('Edit Group'.padEnd(16))} ${chalk.gray('Change members or strategy')}`,     value: 'edit' },
        { name: `${chalk.cyan('Delete Group'.padEnd(16))} ${chalk.gray('Remove a group')}`,               value: 'delete' },
        backChoice,
      ],
      loop: false,
      pageSize: 5,
    });

    switch (choice) {
      case 'list':   await cmdGroupList(); break;
      case 'add':    await cmdGroupAdd(); break;
      case 'edit':   await cmdGroupEdit(); break;
      case 'delete': await cmdGroupDelete(); break;
      default: return;
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdGroupList() {
  const groups = listGroups();
  const entries = Object.entries(groups);
  if (entries.length === 0) { console.log(chalk.yellow('\n  No groups configured.\n')); return; }
  const table = new Table({
    head: [chalk.cyan('Group'), chalk.cyan('Members'), chalk.cyan('Strategy'), chalk.cyan('Default')],
    style: { head: [], border: ['gray'] },
  });
  for (const [name, g] of entries) {
    table.push([
      chalk.white.bold(name),
      g.members.map(m => chalk.gray(m)).join('\n'),
      g.strategy === 'failover' ? chalk.yellow(g.strategy) : chalk.blue(g.strategy),
      g.default ? chalk.green('★') : chalk.gray('—'),
    ]);
  }
  console.log('\n' + table.toString() + '\n');
}

async function cmdGroupAdd() {
  return guard(async () => {
    const name = await input({ message: 'Group name:' });
    if (!name.trim()) { console.log(chalk.gray('  Cancelled — name is required.')); return; }

    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }

    const members = await checkbox({
      message: 'Select members (order = failover order):',
      choices: models.map(m => ({
        name: `${m.provider}:${m.name} ${chalk.gray(`(→ ${m.realModel})`)}`,
        value: `${m.provider}:${m.name}`,
      })),
      pageSize: 20,
    });
    if (members.length === 0) { console.log(chalk.gray('  No members selected.')); return; }

    const strategy = await select({
      message: 'Strategy:',
      choices: [
        { name: 'Failover', value: 'failover' },
        { name: 'Round-robin', value: 'round-robin' },
      ],
    });

    addGroup(name, { members, strategy });
    console.log(chalk.green(`\n  ✔ Group "${name}" created with ${members.length} member(s)\n`));
  });
}

async function cmdGroupEdit() {
  return guard(async () => {
    const groups = Object.keys(listGroups());
    if (groups.length === 0) { console.log(chalk.yellow('\n  No groups configured.\n')); return; }

    const name = await select({
      message: 'Select group to edit:',
      choices: [...groups.map(g => ({ name: g, value: g })), backChoice],
      loop: false,
    });
    if (name === BACK) return;

    const existing = listGroups()[name];
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }

    const members = await checkbox({
      message: 'Select members:',
      choices: models.map(m => {
        const ref = `${m.provider}:${m.name}`;
        return {
          name: `${ref} ${chalk.gray(`(→ ${m.realModel})`)}`,
          value: ref,
          checked: existing.members.includes(ref),
        };
      }),
      pageSize: 20,
    });
    if (members.length === 0) { console.log(chalk.gray('  A group needs at least one member — cancelled.')); return; }

    const strategy = await select({
      message: 'Strategy:',
      default: existing.strategy,
      choices: [
        { name: 'Failover', value: 'failover' },
        { name: 'Round-robin', value: 'round-robin' },
      ],
    });

    editGroup(name, { members, strategy });
    console.log(chalk.green(`\n  ✔ Group "${name}" updated (${members.length} member(s))\n`));
  });
}

async function cmdGroupDelete() {
  return guard(async () => {
    const groups = Object.keys(listGroups());
    if (groups.length === 0) { console.log(chalk.yellow('\n  No groups configured.\n')); return; }

    const name = await select({
      message: 'Select group to delete:',
      choices: [...groups.map(g => ({ name: g, value: g })), backChoice],
      loop: false,
    });
    if (name === BACK) return;

    const yes = await confirm({ message: `Delete group "${name}"?`, default: false });
    if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }

    deleteGroup(name);
    console.log(chalk.green(`\n  ✔ Group "${name}" deleted\n`));
  });
}


// ─── Setup / Status / Config / Help ──────────────────────────────────

async function cmdSetup(args) {
  return guard(async () => {
    const { registerSetupCommands } = await import('../cli/setup.js');
    const { Command } = await import('commander');
    const tmpProgram = new Command();
    registerSetupCommands(tmpProgram);

    let tool = args;
    if (!tool) {
      tool = await select({
        message: 'Select agent to configure:',
        choices: [
          { name: 'Claude Code', value: 'claude-code' },
          { name: 'opencode', value: 'opencode' },
          { name: 'codex', value: 'codex' },
          backChoice,
        ],
        loop: false,
      });
      if (tool === BACK) return;
    }

    const setupCmd = tmpProgram.commands.find(c => c.name() === 'setup');
    const subCmd = setupCmd?.commands.find(c => c.name() === tool);
    if (subCmd) {
      await subCmd.parseAsync([], { from: 'user' });
    } else {
      console.error(chalk.red(`  Unknown agent: "${tool}"`));
    }
  });
}

async function cmdStatus() {
  const config = getConfig();
  console.log(chalk.cyan('\n  ╔══════════════════════════════════════╗'));
  console.log(chalk.cyan('  ║') + chalk.white.bold('   abproxy status                    ') + chalk.cyan('║'));
  console.log(chalk.cyan('  ╚══════════════════════════════════════╝\n'));

  try {
    const resp = await fetch(`http://localhost:${config.port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const health = await resp.json();
      console.log(`  ${chalk.gray('Server:')}    ${chalk.green('● running')}`);
      if (health.uptime) {
        const s = Math.floor(health.uptime);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        console.log(`  ${chalk.gray('Uptime:')}    ${chalk.white(`${h}h ${m}m ${s % 60}s`)}`);
      }
      console.log(`  ${chalk.gray('Requests:')}  ${chalk.white(health.requestCount)}`);
      if (health.providers && Object.keys(health.providers).length > 0) {
        console.log(`\n  ${chalk.gray('Provider Health:')}`);
        for (const [name, status] of Object.entries(health.providers)) {
          console.log(`    ${chalk.white(name)}: ${status.healthy ? chalk.green('● healthy') : chalk.red(`● ${status.reason}`)}`);
        }
      }
    }
  } catch {
    console.log(`  ${chalk.gray('Server:')}    ${chalk.red('● not running')}`);
  }
  console.log(`  ${chalk.gray('Port:')}      ${chalk.white(config.port)}`);
  console.log(`  ${chalk.gray('Default:')}   ${config.defaultModel ? chalk.yellow(config.defaultModel) : chalk.gray('not set')}`);
  console.log('');
}

async function cmdConfig() {
  const { getConfigPath } = await import('../config/manager.js');
  const config = getConfig();
  console.log(`\n  ${chalk.gray('Config:')}   ${chalk.white(getConfigPath())}`);
  console.log(`  ${chalk.gray('API key:')}  ${chalk.white(config.localApiKey)}`);
  console.log(`  ${chalk.gray('Port:')}     ${chalk.white(config.port)}`);
  console.log('');
}

function cmdHelp() {
  const section = (title) => console.log(chalk.cyan(`\n  ${title}`));
  const item = (name, desc) => console.log(`    ${chalk.white(name.padEnd(26))} ${chalk.gray(desc)}`);

  console.log(chalk.cyan.bold('\n  abproxy — command reference'));

  section('Menu (press / to open)');
  for (const cmd of commands) {
    item(cmd.name, cmd.desc);
  }

  section('Providers');
  item('List Providers', 'Table of providers, models and accounts');
  item('Add Provider', 'Type, base URL, one or more accounts, model import');
  item('Edit Provider', 'Change type, base URL, aliases');
  item('Delete Provider', 'Remove provider (cascades to groups)');
  item('Test Provider', 'Live ping using the default account');
  item('Sync Models', 'Re-fetch /v1/models and import new ones');
  item('Manage Accounts', 'List/add/edit/delete accounts, set default');

  section('Models');
  item('List Models', 'Table of all models with aliases');
  item('Add Model', 'Pick provider → name → real model → aliases');
  item('Delete Model', 'Pick provider → model → confirm');
  item('Add Alias', 'Extra name that resolves to a model');
  item('Set Default Model', 'Used when a request omits the model');
  item('Test Model', 'Live completion test');

  section('Groups');
  item('List Groups', 'Virtual failover names and members');
  item('Add Group', 'Members (provider:model) + strategy');
  item('Edit Group', 'Change members or strategy');
  item('Delete Group', 'Remove a group');

  section('Server / daemon (shell)');
  item('abproxy start', 'Start as background daemon');
  item('abproxy start --foreground', 'Start in the foreground');
  item('abproxy stop', 'Stop the daemon');
  item('abproxy restart', 'Restart the daemon');
  item('abproxy status', 'Daemon status + health');
  item('abproxy logs [-f]', 'View or follow logs');

  section('Agent setup (shell)');
  item('abproxy setup claude-code', 'Point Claude Code at abproxy');
  item('abproxy setup opencode', 'Point opencode at abproxy');
  item('abproxy setup codex', 'Point codex at abproxy');

  section('Keyboard');
  item('/', 'Open the menu');
  item('Enter', 'Run the typed command');
  item('Ctrl+C', 'Clear the current input');
  item('Ctrl+D', 'Quit abproxy');
  console.log('');
}

function cmdExit() {
  console.log(chalk.gray('\n  Goodbye! 👋\n'));
  process.exit(0);
}

