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
  getProvider,
  setDefaultProvider,
  setProviderDefaultModel,
  getEffectiveDefaultModel,
  formatDefaultModel,
  addModel,
  deleteModel,
  setDefaultModel,
  listModels,
  addAlias,
  editAlias,
  deleteAlias,
  listAliases,
  getConfig,
  saveConfig,
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
        name: `${m.name} ${chalk.gray(`→ ${m.realModel}`)}` +
          `${m.isProviderDefault ? chalk.cyan(' ◆ default') : ''}` +
          `${m.isDefault ? chalk.green(' ★ global') : ''}`,
        value: m.name,
      })),
      backChoice,
    ],
    loop: false,
    pageSize: 20,
  });
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
  { name: '/aliases',   desc: 'Manage aliases — the model names agents see',               handler: showAliasMenu },
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
 * Loops until the user picks Exit or Back, so sub-menus return here.
 */
export async function showMainMenu() {
  while (true) {
    let choice;
    try {
      choice = await select({
        message: 'abproxy menu:',
        choices: [
          { name: `${chalk.cyan('Providers'.padEnd(12))} ${chalk.gray('Add, edit, test providers & accounts')}`, value: 'providers' },
          { name: `${chalk.cyan('Models'.padEnd(12))} ${chalk.gray('Add, delete, alias, test models')}`,        value: 'models' },
          { name: `${chalk.cyan('Aliases'.padEnd(12))} ${chalk.gray('The model names agents see at /v1/models')}`, value: 'aliases' },
          { name: `${chalk.cyan('Setup'.padEnd(12))} ${chalk.gray('Configure Claude Code / opencode / codex')}`, value: 'setup' },
          { name: `${chalk.cyan('Config'.padEnd(12))} ${chalk.gray('Config path and local API key')}`,          value: 'config' },
          { name: `${chalk.cyan('Help'.padEnd(12))} ${chalk.gray('Full command reference')}`,                   value: 'help' },
          { name: `${chalk.cyan('Exit'.padEnd(12))} ${chalk.gray('Quit abproxy')}`,                             value: 'exit' },
          backChoice,
        ],
        loop: false,
        pageSize: 8,
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
      return;
    }

    switch (choice) {
      case 'providers': await showProviderMenu(); break;
      case 'models':    await showModelMenu(); break;
      case 'aliases':   await showAliasMenu(); break;
      case 'setup':     await cmdSetup(''); break;
      case 'config':    await cmdConfig(); break;
      case 'help':      cmdHelp(); break;
      case 'exit':      return cmdExit();
      default:          return; // Back → command prompt
    }
  }
}

/**
 * Backwards-compatible alias — the REPL previously called this name.
 */
export const showCommandPicker = showMainMenu;

// ─── Provider Menu ───────────────────────────────────────────────────

/**
 * Provider sub-menu. Loops until Back, which returns to the main menu.
 */
export async function showProviderMenu() {
  while (true) {
    let choice;
    try {
      choice = await select({
        message: 'Providers:',
        choices: [
          { name: `${chalk.cyan('List Providers'.padEnd(20))} ${chalk.gray('Show providers table')}`,       value: 'list' },
          { name: `${chalk.cyan('Add Provider'.padEnd(20))} ${chalk.gray('Interactive setup + accounts')}`, value: 'add' },
          { name: `${chalk.cyan('Edit Provider'.padEnd(20))} ${chalk.gray('Type, base URL, protocols')}`,     value: 'edit' },
          { name: `${chalk.cyan('Delete Provider'.padEnd(20))} ${chalk.gray('Remove provider + models')}`,  value: 'delete' },
          { name: `${chalk.cyan('Test Provider'.padEnd(20))} ${chalk.gray('Live ping test')}`,              value: 'test' },
          { name: `${chalk.cyan('Sync Models'.padEnd(20))} ${chalk.gray('Fetch models from upstream')}`,    value: 'sync' },
          { name: `${chalk.cyan('Manage Accounts'.padEnd(20))} ${chalk.gray('Multiple API keys per provider')}`, value: 'accounts' },
          { name: `${chalk.cyan('Set Default Model'.padEnd(20))} ${chalk.gray('Default model for one provider')}`, value: 'default-model' },
          { name: `${chalk.cyan('Set Default Provider'.padEnd(20))} ${chalk.gray('Used when a request has no model')}`, value: 'default-provider' },
          backChoice,
        ],
        loop: false,
        pageSize: 10,
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
      return;
    }

    switch (choice) {
      case 'list':             await cmdProviderList(); break;
      case 'add':              await cmdProviderAdd(); break;
      case 'edit':             await cmdProviderEdit(); break;
      case 'delete':           await cmdProviderDelete(); break;
      case 'test':             await cmdProviderTest(); break;
      case 'sync':             await cmdProviderSync(); break;
      case 'accounts':         await showAccountMenu(); break;
      case 'default-model':    await cmdProviderSetDefaultModel(); break;
      case 'default-provider': await cmdProviderSetDefaultProvider(); break;
      default: return; // Back → main menu
    }
  }
}

async function cmdProviderList() {
  const providers = listProviders();
  const entries = Object.entries(providers);
  if (entries.length === 0) {
    console.log(chalk.yellow('\n  No providers configured. Use Providers → Add Provider\n'));
    return;
  }
  const config = getConfig();
  const table = new Table({
    head: [
      chalk.cyan('Name'),
      chalk.cyan('Type'),
      chalk.cyan('Base URL'),
      chalk.cyan('Protocols'),
      chalk.cyan('Models'),
      chalk.cyan('Accounts'),
      chalk.cyan('Active Account'),
      chalk.cyan('Default Model'),
    ],
    style: { head: [], border: ['gray'] },
  });
  for (const [name, p] of entries) {
    const accountCount = (p.accounts || []).length;
    const supported = Array.isArray(p.protocols)
      ? p.protocols
      : [p.type === 'anthropic-native' ? 'anthropic' : 'openai'];
    table.push([
      config.defaultProvider === name
        ? chalk.green('★ ') + chalk.white.bold(name)
        : chalk.white.bold(name),
      p.type === 'anthropic-native' ? chalk.magenta(p.type) : chalk.blue(p.type),
      chalk.gray(p.baseURL),
      chalk.yellow(supported.join(' + ')),
      chalk.yellow(Object.keys(p.models || {}).length.toString()),
      chalk.yellow(accountCount.toString()),
      accountCount > 0 ? chalk.green(getActiveAccountName(p)) : chalk.gray('—'),
      p.defaultModel ? chalk.cyan(p.defaultModel) : chalk.gray('—'),
    ]);
  }
  console.log('\n' + table.toString() + '\n');
  console.log(chalk.gray('  ★ default provider    ◆ per-provider default model — see Providers → Set Default Model / Set Default Provider\n'));
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

    // Dual-protocol detection (e.g. seekai.cc, gorouter.app — OpenAI-compatible
    // upstreams that ALSO expose the Anthropic-native /v1/messages endpoint)
    let protocols;
    if (type === 'anthropic-native') {
      protocols = ['anthropic'];
    } else {
      const hasAnthropic = await confirm({
        message: 'Does this provider ALSO support Anthropic /v1/messages? (curl docs with "x-api-key" header)',
        default: false,
      });
      protocols = hasAnthropic ? ['openai', 'anthropic'] : ['openai'];
    }

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

    const providerData = { type, baseURL, accounts, models: {}, autoFetch: true, protocols };

    // ── Auto-fetch models using the default account's key ────────
    const spinner = ora('Fetching available models from provider...').start();
    const fetchedModels = await fetchProviderModels(
      { type, baseURL, accounts, protocols },
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
        providerData.models[id] = { realModel: id };
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
        providerData.models[modelName] = { realModel };
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

    // Protocols (dual-protocol support)
    const currentProtocols = Array.isArray(existing.protocols)
      ? existing.protocols
      : [existing.type === 'anthropic-native' ? 'anthropic' : 'openai'];
    const protocols = await select({
      message: 'Supported protocols:',
      default: currentProtocols.length === 2 ? 'both' : currentProtocols[0],
      choices: [
        { name: 'OpenAI only  (/v1/chat/completions, Bearer)', value: 'openai' },
        { name: 'Anthropic only  (/v1/messages, x-api-key)', value: 'anthropic' },
        { name: 'Both (dual-protocol)', value: 'both' },
      ],
      loop: false,
    });

    editProvider(resolved, {
      type, baseURL,
      ...(protocols === 'both'
        ? { protocols: ['openai', 'anthropic'] }
        : { protocols: [protocols] }),
    });
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


// ─── Provider Defaults ───────────────────────────────────────────────

/**
 * Set a provider's own default model. Used when this provider serves a
 * request without a model (i.e. it is the default provider), and for display.
 */
async function cmdProviderSetDefaultModel() {
  return guard(async () => {
    const providerName = await pickProvider('Set default model for provider:');
    if (providerName === BACK) return;

    const modelName = await pickModelOfProvider(providerName, 'Default model for this provider:');
    if (modelName === BACK) return;

    setProviderDefaultModel(providerName, modelName);
    console.log(chalk.green(`\n  ✔ Default model for "${providerName}": "${modelName}"\n`));
  });
}

/**
 * Set the global default provider. When set, requests without a model are
 * served by this provider using its default model.
 */
async function cmdProviderSetDefaultProvider() {
  return guard(async () => {
    const config = getConfig();
    const providers = Object.keys(listProviders());
    if (providers.length === 0) {
      console.log(chalk.yellow('\n  No providers configured. Use Providers → Add Provider\n'));
      return;
    }

    const name = await select({
      message: 'Default provider (serves requests without a model):',
      choices: [
        ...providers.map(p => ({
          name: `${p}${config.defaultProvider === p ? chalk.green(' ★ current') : ''}`,
          value: p,
        })),
        { name: chalk.gray('None — clear default provider'), value: null },
        backChoice,
      ],
      loop: false,
    });
    if (name === BACK) return;

    setDefaultProvider(name);
    if (name === null) {
      console.log(chalk.gray('\n  Default provider cleared.\n'));
      return;
    }

    console.log(chalk.green(`\n  ✔ Default provider: "${name}"`));

    // A default provider is only useful with a default model — offer to pick one now
    const provider = getProvider(name);
    if (provider.defaultModel) {
      console.log(chalk.gray(`  Its default model: ${provider.defaultModel}\n`));
      return;
    }
    if (Object.keys(provider.models || {}).length === 0) {
      console.log(chalk.yellow('  ⚠ This provider has no models yet — set one later via Providers → Set Default Model.\n'));
      return;
    }
    const pickNow = await confirm({ message: 'Pick its default model now?', default: true });
    if (pickNow) {
      const modelName = await pickModelOfProvider(name, 'Default model for this provider:');
      if (modelName === BACK) return;
      setProviderDefaultModel(name, modelName);
      console.log(chalk.green(`\n  ✔ Default model for "${name}": "${modelName}"\n`));
    } else {
      console.log(chalk.yellow('  ⚠ No default model set — requests without a model will fall back to the global default (if any).\n'));
    }
  });
}


// ─── Account Menu ────────────────────────────────────────────────────

/**
 * Account sub-menu. Loops until Back, which returns to the provider menu.
 */
export async function showAccountMenu() {
  while (true) {
    let choice;
    try {
      choice = await select({
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
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
      return;
    }

    switch (choice) {
      case 'list':    await cmdAccountList(); break;
      case 'add':     await cmdAccountAdd(); break;
      case 'edit':    await cmdAccountEdit(); break;
      case 'delete':  await cmdAccountDelete(); break;
      case 'default': await cmdAccountSetDefault(); break;
      default: return; // Back → provider menu
    }
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

/**
 * Model sub-menu. Loops until Back, which returns to the main menu.
 */
export async function showModelMenu() {
  while (true) {
    let choice;
    try {
      choice = await select({
        message: 'Models:',
        choices: [
          { name: `${chalk.cyan('List Models'.padEnd(20))} ${chalk.gray('Show models table')}`,               value: 'list' },
          { name: `${chalk.cyan('Add Model'.padEnd(20))} ${chalk.gray('Add a model to a provider')}`,         value: 'add' },
          { name: `${chalk.cyan('Delete Model'.padEnd(20))} ${chalk.gray('Pick provider → model → confirm')}`, value: 'delete' },
          { name: `${chalk.cyan('Set Default Model'.padEnd(20))} ${chalk.gray('Global fallback default')}`,   value: 'default' },
          { name: `${chalk.cyan('Test Model'.padEnd(20))} ${chalk.gray('Live completion test')}`,             value: 'test' },
          backChoice,
        ],
        loop: false,
        pageSize: 6,
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
      return;
    }

    switch (choice) {
      case 'list':    await cmdModelList(); break;
      case 'add':     await cmdModelAdd(); break;
      case 'delete':  await cmdModelDelete(); break;
      case 'default': await cmdModelDefault(); break;
      case 'test':    await cmdModelTest(); break;
      default: return; // Back → main menu
    }
  }
}

async function cmdModelList(args) {
  const models = listModels(args || null);
  if (models.length === 0) { console.log(chalk.yellow('\n  No models configured.\n')); return; }
  const table = new Table({
    head: [chalk.cyan('Model'), chalk.cyan('Provider'), chalk.cyan('Real Model'), chalk.cyan('Default')],
    style: { head: [], border: ['gray'] },
  });
  for (const m of models) {
    const flags = [
      m.isProviderDefault ? chalk.cyan('◆ provider') : '',
      m.isDefault ? chalk.green('★ global') : '',
    ].filter(Boolean).join(' ');
    table.push([
      chalk.white.bold(m.name),
      chalk.gray(m.provider),
      chalk.blue(m.realModel),
      flags || chalk.gray('—'),
    ]);
  }
  console.log('\n' + table.toString() + '\n');
  console.log(chalk.gray('  These are internal names. Agents only see aliases (main menu → Aliases) and "default".\n'));
}

async function cmdModelAdd() {
  return guard(async () => {
    const providerName = await pickProvider('Add model to provider:');
    if (providerName === BACK) return;

    const modelName = await input({ message: 'Model name:' });
    if (!modelName.trim()) { console.log(chalk.gray('  Cancelled — name is required.')); return; }
    const realModel = await input({ message: 'Real model name (upstream API ID):', default: modelName });

    addModel(providerName, modelName, { realModel });
    console.log(chalk.green(`\n  ✔ Model "${modelName}" added to "${providerName}"`));
    console.log(chalk.gray('  Create an alias (main menu → Aliases) to expose it to agents.\n'));
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

async function cmdModelDefault() {
  return guard(async () => {
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }

    console.log(chalk.gray('\n  This is the global fallback default. If a default provider is set, its own'));
    console.log(chalk.gray('  default model takes priority (Providers → Set Default Provider).\n'));

    const modelName = await select({
      message: 'Set global default model:',
      choices: [
        ...models.map(m => ({
          name: `${m.name} ${chalk.gray(`(${m.provider})`)}` +
            `${m.isProviderDefault ? chalk.cyan(' ◆ provider default') : ''}` +
            `${m.isDefault ? chalk.green(' ★ current') : ''}`,
          value: m.name,
        })),
        { name: chalk.gray('None — clear global default'), value: null },
        backChoice,
      ],
      loop: false,
      pageSize: 20,
    });
    if (modelName === BACK) return;

    if (modelName === null) {
      const config = getConfig();
      config.defaultModel = null;
      saveConfig(config);
      console.log(chalk.gray('\n  Global default model cleared.\n'));
      return;
    }

    setDefaultModel(modelName);
    console.log(chalk.green(`\n  ✔ Global default model: "${modelName}"\n`));
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


// ─── Alias Menu ──────────────────────────────────────────────────────

/**
 * Alias sub-menu. Aliases are the ONLY model names agents see at
 * /v1/models (plus the literal "default"). Loops until Back.
 */
export async function showAliasMenu() {
  while (true) {
    let choice;
    try {
      choice = await select({
        message: 'Aliases (model names for agents):',
        choices: [
          { name: `${chalk.cyan('List Aliases'.padEnd(18))} ${chalk.gray('Show aliases table')}`,              value: 'list' },
          { name: `${chalk.cyan('Add Alias'.padEnd(18))} ${chalk.gray('provider/model-name → agent-visible')}`, value: 'add' },
          { name: `${chalk.cyan('Edit Alias'.padEnd(18))} ${chalk.gray('Rename or re-point an alias')}`,       value: 'edit' },
          { name: `${chalk.cyan('Delete Alias'.padEnd(18))} ${chalk.gray('Remove an alias')}`,                value: 'delete' },
          backChoice,
        ],
        loop: false,
        pageSize: 5,
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
      return;
    }

    switch (choice) {
      case 'list':   await cmdAliasList(); break;
      case 'add':    await cmdAliasAdd(); break;
      case 'edit':   await cmdAliasEdit(); break;
      case 'delete': await cmdAliasDelete(); break;
      default: return; // Back → main menu
    }
  }
}

async function cmdAliasList() {
  const aliases = listAliases();
  const entries = Object.entries(aliases);
  if (entries.length === 0) {
    console.log(chalk.yellow('\n  No aliases configured. Agents see only "default" until you add some.\n'));
    return;
  }
  const table = new Table({
    head: [chalk.cyan('Alias (agent-visible)'), chalk.cyan('Provider'), chalk.cyan('Model'), chalk.cyan('Real Model')],
    style: { head: [], border: ['gray'] },
  });
  for (const [name, a] of entries) {
    const model = listModels(a.provider).find(m => m.name === a.model);
    table.push([
      chalk.white.bold(name),
      chalk.gray(a.provider),
      chalk.blue(a.model),
      model ? chalk.gray(model.realModel) : chalk.red('(missing)'),
    ]);
  }
  console.log('\n' + table.toString() + '\n');
  console.log(chalk.gray('  Plus the literal "default" → default provider\'s default model.\n'));
}

async function cmdAliasAdd() {
  return guard(async () => {
    const models = listModels();
    if (models.length === 0) {
      console.log(chalk.yellow('\n  No models configured. Add a provider with models first.\n'));
      return;
    }

    // Pick provider → model, then default the alias name to provider/model
    const providerName = await pickProvider('Alias points at provider:');
    if (providerName === BACK) return;

    const modelName = await pickModelOfProvider(providerName, 'Alias points at model:');
    if (modelName === BACK) return;

    const suggested = `${providerName}/${modelName}`;
    const aliasName = await input({
      message: 'Alias name (what agents will see):',
      default: suggested,
    });
    if (!aliasName.trim()) { console.log(chalk.gray('  Cancelled — name is required.')); return; }

    addAlias(aliasName, { provider: providerName, model: modelName });
    console.log(chalk.green(`\n  ✔ Alias "${aliasName}" → ${providerName}:${modelName}`));
    console.log(chalk.gray('  It now appears in /v1/models and is usable as a model name.\n'));
  });
}

async function cmdAliasEdit() {
  return guard(async () => {
    const aliases = Object.keys(listAliases());
    if (aliases.length === 0) { console.log(chalk.yellow('\n  No aliases configured.\n')); return; }

    const aliasName = await select({
      message: 'Select alias to edit:',
      choices: [...aliases.map(a => ({ name: a, value: a })), backChoice],
      loop: false,
    });
    if (aliasName === BACK) return;

    const existing = listAliases()[aliasName];
    const newName = await input({ message: 'Alias name:', default: aliasName });

    const providerName = await pickProvider('Alias points at provider:');
    if (providerName === BACK) return;

    const modelName = await pickModelOfProvider(providerName, 'Alias points at model:');
    if (modelName === BACK) return;

    editAlias(aliasName, { name: newName, provider: providerName, model: modelName });
    console.log(chalk.green(`\n  ✔ Alias "${newName}" → ${providerName}:${modelName}\n`));
  });
}

async function cmdAliasDelete() {
  return guard(async () => {
    const aliases = Object.keys(listAliases());
    if (aliases.length === 0) { console.log(chalk.yellow('\n  No aliases configured.\n')); return; }

    const aliasName = await select({
      message: 'Select alias to delete:',
      choices: [...aliases.map(a => ({ name: a, value: a })), backChoice],
      loop: false,
    });
    if (aliasName === BACK) return;

    const yes = await confirm({ message: `Delete alias "${aliasName}"?`, default: false });
    if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }

    deleteAlias(aliasName);
    console.log(chalk.green(`\n  ✔ Alias "${aliasName}" deleted\n`));
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
  const effDefault = formatDefaultModel(config);
  console.log(`  ${chalk.gray('Default:')}   ${effDefault ? chalk.yellow(effDefault) : chalk.gray('not set')}` +
    (config.defaultProvider ? chalk.gray('  (default provider)') : ''));
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
  item('Delete Provider', 'Remove provider (cascades to aliases)');
  item('Test Provider', 'Live ping using the default account');
  item('Sync Models', 'Re-fetch /v1/models and import new ones');
  item('Manage Accounts', 'List/add/edit/delete accounts, set default');
  item('Set Default Model', 'Per-provider default model (◆)');
  item('Set Default Provider', 'Provider used when a request has no model');

  section('Default model resolution');
  item('1. Default provider', 'If set, its default model serves requests without a model');
  item('2. Global default', 'Fallback when no default provider/model is set');
  item('Models → Set Default', 'Sets the global fallback default');

  section('Models');
  item('List Models', 'Internal model table (providers → real models)');
  item('Add Model', 'Pick provider → name → real model');
  item('Delete Model', 'Pick provider → model → confirm');
  item('Set Default Model', 'Fallback default for the default provider');
  item('Test Model', 'Live completion test');

  section('Aliases (agent-visible model names)');
  item('List Aliases', 'Table of aliases + what they point at');
  item('Add Alias', 'Pick provider → model → name (default: provider/model)');
  item('Edit Alias', 'Rename or re-point an alias');
  item('Delete Alias', 'Remove an alias (agents lose that model name)');

  section('How agents see models');
  item('/v1/models', 'Shows aliases + the literal "default" — nothing else');
  item('default', 'Resolves to the default provider\'s default model');
  item('Unknown name', 'Falls back to the default provider\'s default model');
  item('Account rotation', 'On 429/402 the provider\'s next account is tried');

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

