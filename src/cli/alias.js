import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { input, select, confirm } from '@inquirer/prompts';
import {
  addAlias,
  editAlias,
  deleteAlias,
  listAliases,
  listModels,
  listProviders,
  resolveProviderName,
  getConfig,
} from '../config/manager.js';

export function registerAliasCommands(program) {
  const alias = program.command('alias').description('Manage aliases — the model names agents see');

  // ─── alias list ─────────────────────────────────────────────────
  alias
    .command('list')
    .description('List all aliases')
    .action(() => {
      const aliases = listAliases();
      const entries = Object.entries(aliases);

      if (entries.length === 0) {
        console.log(chalk.yellow('\n  No aliases configured. Agents see only "default" until you add some.\n'));
        return;
      }

      const config = getConfig();
      const table = new Table({
        head: [
          chalk.cyan('Alias (agent-visible)'),
          chalk.cyan('Provider'),
          chalk.cyan('Model'),
          chalk.cyan('Real Model'),
        ],
        style: { head: [], border: ['gray'] },
      });

      for (const [name, a] of entries) {
        const provider = config.providers[a.provider];
        const realModel = provider?.models?.[a.model]?.realModel;
        table.push([
          chalk.white.bold(name),
          chalk.gray(a.provider),
          chalk.blue(a.model),
          realModel ? chalk.gray(realModel) : chalk.red('(missing)'),
        ]);
      }

      console.log('\n' + table.toString() + '\n');
      console.log(chalk.gray('  Plus the literal "default" → default provider\'s default model.\n'));
    });

  // ─── alias add ─────────────────────────────────────────────────
  alias
    .command('add [name] [provider] [model]')
    .description('Create an alias (e.g. abproxy alias add gorouter/claude-opus-4-8 gorouter claude-opus-4-8)')
    .action(async (name, providerRef, modelRef) => {
      try {
        const config = getConfig();
        let aliasName = name;
        let providerName = providerRef;
        let modelName = modelRef;

        if (!providerName) {
          const providers = Object.keys(listProviders());
          if (providers.length === 0) {
            console.error(chalk.red('✖ No providers configured.'));
            return;
          }
          providerName = await select({
            message: 'Alias points at provider:',
            choices: providers.map(p => ({ name: p, value: p })),
            loop: false,
          });
        } else {
          const resolved = resolveProviderName(config, providerName);
          if (!resolved) {
            console.error(chalk.red(`✖ Provider "${providerName}" not found`));
            return;
          }
          providerName = resolved;
        }

        const provider = config.providers[providerName];
        const modelNames = Object.keys(provider.models || {});
        if (modelNames.length === 0) {
          console.error(chalk.red(`✖ Provider "${providerName}" has no models`));
          return;
        }

        if (!modelName) {
          modelName = await select({
            message: 'Alias points at model:',
            choices: modelNames.map(m => ({ name: m, value: m })),
            loop: false,
          });
        } else if (!provider.models[modelName]) {
          console.error(chalk.red(`✖ Model "${modelName}" not found on provider "${providerName}"`));
          return;
        }

        if (!aliasName) {
          aliasName = await input({
            message: 'Alias name (what agents will see):',
            default: `${providerName}/${modelName}`,
          });
        }

        addAlias(aliasName, { provider: providerName, model: modelName });
        console.log(chalk.green(`\n✔ Alias "${aliasName}" → ${providerName}:${modelName}`));
        console.log(chalk.gray('  It now appears in /v1/models and is usable as a model name.'));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── alias edit ────────────────────────────────────────────────
  alias
    .command('edit <name>')
    .description('Rename or re-point an alias')
    .action(async (name) => {
      try {
        const config = getConfig();
        const existing = config.aliases?.[name];
        if (!existing) {
          console.error(chalk.red(`✖ Alias "${name}" not found`));
          return;
        }

        const newName = await input({ message: 'Alias name:', default: name });
        const providerName = await select({
          message: 'Alias points at provider:',
          choices: Object.keys(listProviders()).map(p => ({ name: p, value: p })),
          default: existing.provider,
          loop: false,
        });
        const modelName = await select({
          message: 'Alias points at model:',
          choices: Object.keys(config.providers[providerName].models || {}).map(m => ({ name: m, value: m })),
          default: existing.model,
          loop: false,
        });

        editAlias(name, { name: newName, provider: providerName, model: modelName });
        console.log(chalk.green(`\n✔ Alias "${newName}" → ${providerName}:${modelName}`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── alias delete ───────────────────────────────────────────────
  alias
    .command('delete <name>')
    .description('Delete an alias')
    .action(async (name) => {
      try {
        const yes = await confirm({ message: `Delete alias "${name}"?`, default: false });
        if (!yes) {
          console.log(chalk.gray('  Cancelled.'));
          return;
        }
        deleteAlias(name);
        console.log(chalk.green(`\n✔ Alias "${name}" deleted`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });
}
