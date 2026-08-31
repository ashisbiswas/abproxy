import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { input, select, confirm } from '@inquirer/prompts';
import {
  addModel,
  editModel,
  deleteModel,
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

        const modelName = await input({ message: 'Model name (your internal name, e.g. "opus-5"):' });
        const realModel = await input({ message: 'Real model name (API model ID):' });

        addModel(resolvedProvider, modelName, { realModel });
        console.log(chalk.green(`\n✔ Model "${modelName}" added to provider "${resolvedProvider}"`));
        console.log(chalk.gray('  Expose it to agents with: abproxy alias add <alias-name> <provider> <model>'));
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
          chalk.cyan('Default'),
        ],
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
      console.log(chalk.gray('  Internal names only — agents see aliases (abproxy alias list) and "default".\n'));
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

        editModel(resolvedProvider, modelName, { realModel });
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
          message: `Delete model "${modelName}" from "${providerRef}"? Aliases pointing at it will be removed.`,
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

  // ─── model set-default ─────────────────────────────────────────
  model
    .command('set-default <model>')
    .description('Set the global fallback default model')
    .action(async (modelName) => {
      try {
        setDefaultModel(modelName);
        console.log(chalk.green(`✔ Global fallback default model set to "${modelName}"`));
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
