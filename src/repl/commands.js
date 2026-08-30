import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { input, select, confirm, checkbox } from '@inquirer/prompts';
import {
  addProvider,
  editProvider,
  deleteProvider,
  listProviders,
  addModel,
  editModel,
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

/**
 * Slash command registry
 */
export const commands = [
  { name: '/providers',        desc: 'List providers (table)',                 handler: cmdProviderList },
  { name: '/provider add',     desc: 'Add a provider interactively',          handler: cmdProviderAdd },
  { name: '/provider edit',    desc: 'Edit a provider',                       handler: cmdProviderEdit },
  { name: '/provider delete',  desc: 'Delete a provider',                     handler: cmdProviderDelete },
  { name: '/provider test',    desc: 'Test a provider',                       handler: cmdProviderTest },
  { name: '/provider sync',    desc: 'Sync models from upstream provider',    handler: cmdProviderSync },
  { name: '/models',           desc: 'List models (optionally filter)',        handler: cmdModelList },
  { name: '/model add',        desc: 'Add a model to a provider',             handler: cmdModelAdd },
  { name: '/model alias',      desc: 'Add an alias to a model',               handler: cmdModelAlias },
  { name: '/model default',    desc: 'Set the default model',                 handler: cmdModelDefault },
  { name: '/model test',       desc: 'Test a model',                          handler: cmdModelTest },
  { name: '/groups',           desc: 'List model groups',                     handler: cmdGroupList },
  { name: '/group add',        desc: 'Create a model group',                  handler: cmdGroupAdd },
  { name: '/setup',            desc: 'Setup an agent (claude-code|opencode|codex)', handler: cmdSetup },
  { name: '/status',           desc: 'Server state and health',               handler: cmdStatus },
  { name: '/config',           desc: 'Show config file path and key',         handler: cmdConfig },
  { name: '/help',             desc: 'Show this help',                        handler: cmdHelp },
  { name: '/exit',             desc: 'Exit abproxy',                          handler: cmdExit },
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

/**
 * Show fuzzy command picker
 */
export async function showCommandPicker() {
  try {
    const choice = await select({
      message: 'Select a command:',
      choices: [
        ...commands.map(c => ({
          name: `${chalk.cyan(c.name.padEnd(22))} ${chalk.gray(c.desc)}`,
          value: c.name,
        })),
        backChoice,
      ],
      loop: false,
      pageSize: commands.length + 1,
    });
    if (choice === BACK) return;
    const cmd = commands.find(c => c.name === choice);
    if (cmd) await cmd.handler('');
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
  }
}

// ─── Command Handlers ────────────────────────────────────────────────

async function cmdProviderList() {
  const providers = listProviders();
  const entries = Object.entries(providers);
  if (entries.length === 0) {
    console.log(chalk.yellow('\n  No providers configured. Use /provider add\n'));
    return;
  }
  const table = new Table({
    head: [chalk.cyan('Name'), chalk.cyan('Type'), chalk.cyan('Base URL'), chalk.cyan('Aliases'), chalk.cyan('Models')],
    style: { head: [], border: ['gray'] },
  });
  for (const [name, p] of entries) {
    table.push([
      chalk.white.bold(name),
      p.type === 'anthropic-native' ? chalk.magenta(p.type) : chalk.blue(p.type),
      chalk.gray(p.baseURL),
      (p.aliases || []).join(', ') || chalk.gray('—'),
      chalk.yellow(Object.keys(p.models || {}).length.toString()),
    ]);
  }
  console.log('\n' + table.toString() + '\n');
}

async function cmdProviderAdd() {
  try {
    const name = await input({ message: 'Provider name:' });
    const type = await select({
      message: 'Provider type:',
      choices: [
        { name: 'Anthropic Native', value: 'anthropic-native' },
        { name: 'OpenAI Compatible', value: 'openai-compatible' },
      ],
    });
    const baseURL = await input({ message: 'Base URL:' });
    const apiKey = await input({ message: 'API key:' });
    const aliasStr = await input({ message: 'Aliases (comma-separated, or blank):' });
    const aliases = aliasStr ? aliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];
    const providerData = { type, baseURL, apiKey, aliases, models: {}, autoFetch: true };

    // Auto-fetch models
    const spinner = ora('Fetching available models from provider...').start();
    const fetchedModels = await fetchProviderModels(
      { type, baseURL, apiKey },
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
        const mAliasStr = await input({ message: '  Model aliases (or blank):' });
        const mAliases = mAliasStr ? mAliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];
        providerData.models[modelName] = { realModel, aliases: mAliases };
        addMore = await confirm({ message: 'Add another model?', default: false });
      }
    }

    addProvider(name, providerData);
    const mc = Object.keys(providerData.models).length;
    console.log(chalk.green(`\n  ✔ Provider "${name}" added (${mc} model${mc !== 1 ? 's' : ''})\n`));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdProviderEdit(args) {
  try {
    let name = args;
    if (!name) {
      const providers = Object.keys(listProviders());
      if (providers.length === 0) { console.log(chalk.yellow('  No providers.')); return; }
      name = await select({ message: 'Select provider to edit:', choices: [...providers.map(p => ({ name: p, value: p })), backChoice], loop: false });
      if (name === BACK) return;
    }
    const config = getConfig();
    const resolved = resolveProviderName(config, name);
    if (!resolved) { console.error(chalk.red(`  ✖ Not found: "${name}"`)); return; }
    const existing = config.providers[resolved];

    const type = await select({
      message: 'Type:', default: existing.type,
      choices: [
        { name: 'Anthropic Native', value: 'anthropic-native' },
        { name: 'OpenAI Compatible', value: 'openai-compatible' },
      ],
    });
    const baseURL = await input({ message: 'Base URL:', default: existing.baseURL });
    const apiKey = await input({ message: 'API key:', default: existing.apiKey });
    const aliasStr = await input({ message: 'Aliases:', default: (existing.aliases || []).join(', ') });
    const aliases = aliasStr ? aliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];

    editProvider(resolved, { type, baseURL, apiKey, aliases });
    console.log(chalk.green(`\n  ✔ Provider "${resolved}" updated\n`));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdProviderDelete(args) {
  try {
    let name = args;
    if (!name) {
      const providers = Object.keys(listProviders());
      if (providers.length === 0) { console.log(chalk.yellow('  No providers.')); return; }
      name = await select({ message: 'Select provider to delete:', choices: [...providers.map(p => ({ name: p, value: p })), backChoice], loop: false });
      if (name === BACK) return;
    }
    const yes = await confirm({ message: `Delete "${name}" and all its models?`, default: false });
    if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }
    deleteProvider(name);
    console.log(chalk.green(`\n  ✔ Deleted "${name}"\n`));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdProviderTest(args) {
  let name = args;
  if (!name) {
    const providers = Object.keys(listProviders());
    if (providers.length === 0) { console.log(chalk.yellow('  No providers.')); return; }
    name = await select({ message: 'Select provider to test:', choices: [...providers.map(p => ({ name: p, value: p })), backChoice], loop: false });
    if (name === BACK) return;
  }
  const spinner = ora(`Testing "${name}"...`).start();
  const result = await testProvider(name);
  spinner.stop();
  console.log(formatTestResult(result));
}

async function cmdProviderSync(args) {
  let name = args;
  if (!name) {
    const providers = Object.keys(listProviders());
    if (providers.length === 0) { console.log(chalk.yellow('  No providers.')); return; }
    name = await select({ message: 'Select provider to sync:', choices: [...providers.map(p => ({ name: p, value: p })), backChoice], loop: false });
    if (name === BACK) return;
  }
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
  try {
    const providers = Object.keys(listProviders());
    if (providers.length === 0) { console.log(chalk.yellow('  No providers. Add one first.')); return; }
    const providerName = await select({ message: 'Provider:', choices: [...providers.map(p => ({ name: p, value: p })), backChoice], loop: false });
    if (providerName === BACK) return;
    const modelName = await input({ message: 'Model name:' });
    const realModel = await input({ message: 'Real model name:' });
    const aliasStr = await input({ message: 'Aliases (or blank):' });
    const aliases = aliasStr ? aliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];
    addModel(providerName, modelName, { realModel, aliases });
    console.log(chalk.green(`\n  ✔ Model "${modelName}" added to "${providerName}"\n`));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdModelAlias() {
  try {
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }
    const modelName = await select({ message: 'Model:', choices: [...models.map(m => ({ name: `${m.name} (${m.provider})`, value: m.name })), backChoice], loop: false });
    if (modelName === BACK) return;
    const alias = await input({ message: 'New alias:' });
    addModelAlias(modelName, alias);
    console.log(chalk.green(`  ✔ Alias "${alias}" added to "${modelName}"`));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdModelDefault() {
  try {
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }
    const modelName = await select({ message: 'Set default model:', choices: [...models.map(m => ({
      name: `${m.name} (${m.provider})${m.isDefault ? ' ★ current' : ''}`,
      value: m.name,
    })), backChoice], loop: false });
    if (modelName === BACK) return;
    setDefaultModel(modelName);
    console.log(chalk.green(`  ✔ Default model: "${modelName}"`));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdModelTest(args) {
  let modelRef = args;
  if (!modelRef) {
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }
    modelRef = await select({ message: 'Model to test:', choices: [...models.map(m => ({
      name: `${m.name} (${m.provider})`,
      value: `${m.provider}:${m.name}`,
    })), backChoice], loop: false });
    if (modelRef === BACK) return;
  }
  const spinner = ora(`Testing "${modelRef}"...`).start();
  const result = await testModel(modelRef);
  spinner.stop();
  console.log(formatTestResult(result));
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
  try {
    const name = await input({ message: 'Group name:' });
    const models = listModels();
    if (models.length === 0) { console.log(chalk.yellow('  No models.')); return; }
    const members = await checkbox({
      message: 'Select members:',
      choices: models.map(m => ({
        name: `${m.provider}:${m.name} (→ ${m.realModel})`,
        value: `${m.provider}:${m.name}`,
      })),
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
    console.log(chalk.green(`\n  ✔ Group "${name}" created\n`));
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}

async function cmdSetup(args) {
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

  // Execute the setup command
  const setupCmd = tmpProgram.commands.find(c => c.name() === 'setup');
  const subCmd = setupCmd?.commands.find(c => c.name() === tool);
  if (subCmd) {
    await subCmd.parseAsync([], { from: 'user' });
  } else {
    console.error(chalk.red(`  Unknown agent: "${tool}"`));
  }
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
  console.log('');
}

function cmdHelp() {
  console.log(chalk.cyan('\n  Available commands:\n'));
  for (const cmd of commands) {
    console.log(`  ${chalk.white(cmd.name.padEnd(24))} ${chalk.gray(cmd.desc)}`);
  }
  console.log('');
}

function cmdExit() {
  console.log(chalk.gray('\n  Goodbye! 👋\n'));
  process.exit(0);
}
