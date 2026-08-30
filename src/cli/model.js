import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { input, select, confirm } from '@inquirer/prompts';
import {
  addModel,
  editModel,
  deleteModel,
  addModelAlias,
  setDefaultModel,
  listModels,
  listProviders,
  resolveProviderName,
  getConfig,
} from '../config/manager.js';
import { testModel, formatTestResult } from '../utils/testing.js';

export function registerModelCommands(program) {
  const model = program.command('model').description('Manage models');

  // ─── model add ─────────────────────────────────────────────────
  model
    .command('add <provider>')
    .description('Add a model to a provider (interactive)')
    .action(async (providerRef) => {
      try {
        const config = getConfig();
        const resolvedProvider = resolveProviderName(config, providerRef);
        if (!resolvedProvider) {
          console.error(chalk.red(`✖ Provider "${providerRef}" not found`));
          return;
        }

        const modelName = await input({ message: 'Model name (your alias, e.g. "opus-5"):' });
        const realModel = await input({ message: 'Real model name (API model ID):' });
        const aliasStr = await input({ message: 'Model aliases (comma-separated, or blank):' });
        const aliases = aliasStr ? aliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];

        addModel(resolvedProvider, modelName, { realModel, aliases });
        console.log(chalk.green(`\n✔ Model "${modelName}" added to provider "${resolvedProvider}"`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── model list ────────────────────────────────────────────────
  model
    .command('list')
    .description('List all models')
    .option('-p, --provider <name>', 'Filter by provider')
    .action((opts) => {
      const models = listModels(opts.provider);

      if (models.length === 0) {
        console.log(chalk.yellow('\n  No models configured.\n'));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan('Model'),
          chalk.cyan('Provider'),
          chalk.cyan('Real Model'),
          chalk.cyan('Aliases'),
          chalk.cyan('Default'),
        ],
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
    });

  // ─── model edit ────────────────────────────────────────────────
  model
    .command('edit <provider> <model>')
    .description('Edit a model')
    .action(async (providerRef, modelName) => {
      try {
        const config = getConfig();
        const resolvedProvider = resolveProviderName(config, providerRef);
        if (!resolvedProvider) {
          console.error(chalk.red(`✖ Provider "${providerRef}" not found`));
          return;
        }
        const provider = config.providers[resolvedProvider];
        const existing = provider.models[modelName];
        if (!existing) {
          console.error(chalk.red(`✖ Model "${modelName}" not found on provider "${resolvedProvider}"`));
          return;
        }

        const realModel = await input({ message: 'Real model name:', default: existing.realModel });
        const aliasStr = await input({
          message: 'Aliases (comma-separated):',
          default: (existing.aliases || []).join(', '),
        });
        const aliases = aliasStr ? aliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];

        editModel(resolvedProvider, modelName, { realModel, aliases });
        console.log(chalk.green(`\n✔ Model "${modelName}" updated`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── model delete ──────────────────────────────────────────────
  model
    .command('delete <provider> <model>')
    .description('Delete a model from a provider')
    .action(async (providerRef, modelName) => {
      try {
        const yes = await confirm({
          message: `Delete model "${modelName}" from "${providerRef}"?`,
          default: false,
        });
        if (!yes) {
          console.log(chalk.gray('  Cancelled.'));
          return;
        }

        deleteModel(providerRef, modelName);
        console.log(chalk.green(`\n✔ Model "${modelName}" deleted`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── model alias ───────────────────────────────────────────────
  model
    .command('alias <model> <alias>')
    .description('Add an alias to a model')
    .action(async (modelName, alias) => {
      try {
        addModelAlias(modelName, alias);
        console.log(chalk.green(`✔ Alias "${alias}" added to model "${modelName}"`));
      } catch (err) {
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── model set-default ─────────────────────────────────────────
  model
    .command('set-default <model>')
    .description('Set the default model')
    .action(async (modelName) => {
      try {
        setDefaultModel(modelName);
        console.log(chalk.green(`✔ Default model set to "${modelName}"`));
      } catch (err) {
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── model test ────────────────────────────────────────────────
  model
    .command('test <model>')
    .description('Test a model with a live completion')
    .action(async (modelRef) => {
      const spinner = ora(`Testing model "${modelRef}"...`).start();
      const result = await testModel(modelRef);
      spinner.stop();
      console.log(formatTestResult(result));
    });
}
