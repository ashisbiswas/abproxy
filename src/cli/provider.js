import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { input, select, confirm, checkbox } from '@inquirer/prompts';
import {
  addProvider,
  editProvider,
  deleteProvider,
  listProviders,
  resolveProviderName,
  getConfig,
  addModel,
  editAccount,
  getActiveApiKey,
  getActiveAccountName,
  importFetchedModels,
  syncProviderModels,
  setDefaultProvider,
  setProviderDefaultModel,
  getProvider,
} from '../config/manager.js';
import { testProvider, formatTestResult } from '../utils/testing.js';
import { fetchProviderModels } from '../server/models-fetcher.js';

export function registerProviderCommands(program) {
  const provider = program.command('provider').description('Manage providers');

  // ─── provider add ──────────────────────────────────────────────
  provider
    .command('add')
    .description('Add a new provider (interactive)')
    .action(async () => {
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

        // Dual-protocol detection (seekai.cc, gorouter.app, etc.)
        let protocols;
        if (type === 'anthropic-native') {
          protocols = ['anthropic'];
        } else {
          const hasAnthropic = await confirm({
            message: 'Does this provider ALSO support Anthropic /v1/messages? (docs with "x-api-key" header)',
            default: false,
          });
          protocols = hasAnthropic ? ['openai', 'anthropic'] : ['openai'];
        }

        const providerData = { type, baseURL, apiKey, aliases, models: {}, autoFetch: true, protocols };

        // ── Try to auto-fetch models from the provider ──────────
        const spinner = ora('Fetching available models from provider...').start();
        const fetchedModels = await fetchProviderModels(
          { type, baseURL, apiKey, protocols },
          { providerName: name, skipCache: true }
        );
        spinner.stop();

        if (fetchedModels.length > 0) {
          console.log(chalk.green(`  ✔ Found ${fetchedModels.length} model(s) from provider\n`));

          const selectedIds = await checkbox({
            message: 'Select models to import:',
            choices: fetchedModels.map(m => ({
              name: `${m.id}${m.owned_by && m.owned_by !== name ? chalk.gray(` (${m.owned_by})`) : ''}`,
              value: m.id,
              checked: true,
            })),
            pageSize: 20,
          });

          for (const id of selectedIds) {
            providerData.models[id] = { realModel: id, aliases: [] };
          }

          if (selectedIds.length > 0) {
            console.log(chalk.gray(`  Imported ${selectedIds.length} model(s)`));
          }
        } else {
          console.log(chalk.yellow('  ⚠ Could not fetch models from provider (endpoint may not support /v1/models)'));

          // Fallback: manual model entry
          let addMore = await confirm({ message: 'Add a model manually?', default: true });
          while (addMore) {
            const modelName = await input({ message: '  Model name (your alias, e.g. "opus-5"):' });
            const realModel = await input({ message: '  Real model name (API model ID):' });
            const modelAliasStr = await input({ message: '  Model aliases (comma-separated, or blank):' });
            const modelAliases = modelAliasStr ? modelAliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];

            providerData.models[modelName] = { realModel, aliases: modelAliases };
            addMore = await confirm({ message: 'Add another model?', default: false });
          }
        }

        addProvider(name, providerData);
        const modelCount = Object.keys(providerData.models).length;
        console.log(chalk.green(`\n✔ Provider "${name}" added successfully (${modelCount} model${modelCount !== 1 ? 's' : ''})`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── provider list ─────────────────────────────────────────────
  provider
    .command('list')
    .description('List all providers')
    .action(() => {
      const providers = listProviders();
      const entries = Object.entries(providers);

      if (entries.length === 0) {
        console.log(chalk.yellow('\n  No providers configured. Run "abproxy provider add" to get started.\n'));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan('Name'),
          chalk.cyan('Type'),
          chalk.cyan('Base URL'),
          chalk.cyan('Protocols'),
          chalk.cyan('Aliases'),
          chalk.cyan('Models'),
          chalk.cyan('Accounts'),
          chalk.cyan('Active Account'),
        ],
        style: { head: [], border: ['gray'] },
      });

      for (const [name, p] of entries) {
        const modelCount = Object.keys(p.models || {}).length;
        const accountCount = (p.accounts || []).length;
        const supported = Array.isArray(p.protocols)
          ? p.protocols
          : [p.type === 'anthropic-native' ? 'anthropic' : 'openai'];
        table.push([
          chalk.white.bold(name),
          p.type === 'anthropic-native' ? chalk.magenta(p.type) : chalk.blue(p.type),
          chalk.gray(p.baseURL),
          chalk.yellow(supported.join(' + ')),
          (p.aliases || []).join(', ') || chalk.gray('—'),
          chalk.yellow(modelCount.toString()),
          chalk.yellow(accountCount.toString()),
          accountCount > 0 ? chalk.green(getActiveAccountName(p)) : chalk.gray('—'),
        ]);
      }

      console.log('\n' + table.toString() + '\n');
    });

  // ─── provider edit ─────────────────────────────────────────────
  provider
    .command('edit <name>')
    .description('Edit a provider')
    .action(async (name) => {
      try {
        const config = getConfig();
        const resolvedName = resolveProviderName(config, name);
        if (!resolvedName) {
          console.error(chalk.red(`✖ Provider "${name}" not found`));
          return;
        }
        const existing = config.providers[resolvedName];

        const type = await select({
          message: 'Provider type:',
          choices: [
            { name: 'Anthropic Native', value: 'anthropic-native' },
            { name: 'OpenAI Compatible', value: 'openai-compatible' },
          ],
          default: existing.type,
        });
        const baseURL = await input({ message: 'Base URL:', default: existing.baseURL });
        const apiKey = await input({
          message: `API key (account "${getActiveAccountName(existing)}"):`,
          default: getActiveApiKey(existing),
        });
        const aliasStr = await input({
          message: 'Aliases (comma-separated):',
          default: (existing.aliases || []).join(', '),
        });
        const aliases = aliasStr ? aliasStr.split(',').map(a => a.trim()).filter(Boolean) : [];

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

        editProvider(resolvedName, {
          type, baseURL, aliases,
          ...(protocols === 'both'
            ? { protocols: ['openai', 'anthropic'] }
            : { protocols: [protocols] }),
        });

        // Write the key back to the active account (multi-account aware)
        if (apiKey && apiKey !== getActiveApiKey(existing)) {
          editAccount(resolvedName, getActiveAccountName(existing), { apiKey });
        }
        console.log(chalk.green(`\n✔ Provider "${resolvedName}" updated`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── provider delete ───────────────────────────────────────────
  provider
    .command('delete <name>')
    .description('Delete a provider')
    .action(async (name) => {
      try {
        const config = getConfig();
        const resolvedName = resolveProviderName(config, name);
        if (!resolvedName) {
          console.error(chalk.red(`✖ Provider "${name}" not found`));
          return;
        }

        const yes = await confirm({
          message: `Delete provider "${resolvedName}" and all its models? This cannot be undone.`,
          default: false,
        });
        if (!yes) {
          console.log(chalk.gray('  Cancelled.'));
          return;
        }

        deleteProvider(resolvedName);
        console.log(chalk.green(`\n✔ Provider "${resolvedName}" deleted`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── provider test ─────────────────────────────────────────────
  provider
    .command('test <name>')
    .description('Test a provider with a live ping')
    .action(async (name) => {
      const spinner = ora(`Testing provider "${name}"...`).start();
      const result = await testProvider(name);
      spinner.stop();
      console.log(formatTestResult(result));
    });

  // ─── provider sync ─────────────────────────────────────────────
  provider
    .command('sync <name>')
    .description('Sync models from upstream provider (re-fetch /v1/models)')
    .action(async (name) => {
      try {
        const config = getConfig();
        const resolvedName = resolveProviderName(config, name);
        if (!resolvedName) {
          console.error(chalk.red(`✖ Provider "${name}" not found`));
          return;
        }
        const providerConfig = config.providers[resolvedName];

        const spinner = ora(`Fetching models from "${resolvedName}"...`).start();
        const fetchedModels = await fetchProviderModels(providerConfig, {
          providerName: resolvedName,
          skipCache: true,
        });
        spinner.stop();

        if (fetchedModels.length === 0) {
          console.log(chalk.yellow('  ⚠ No models returned from provider'));
          return;
        }

        // Diff against current config
        const diff = syncProviderModels(resolvedName, fetchedModels);

        console.log(chalk.cyan(`\n  Models from "${resolvedName}":`));
        console.log(chalk.gray(`    Upstream total: ${fetchedModels.length}`));
        console.log(chalk.green(`    Already configured: ${diff.existing.length}`));
        console.log(chalk.yellow(`    New (not in config): ${diff.added.length}`));
        if (diff.stale.length > 0) {
          console.log(chalk.red(`    Stale (in config, not upstream): ${diff.stale.length}`));
          for (const s of diff.stale) {
            console.log(chalk.red(`      • ${s}`));
          }
        }

        if (diff.added.length === 0) {
          console.log(chalk.green('\n  ✔ All upstream models are already configured.\n'));
          return;
        }

        // Let user select which new models to add
        const toAdd = await checkbox({
          message: 'Select new models to import:',
          choices: diff.added.map(id => ({
            name: id,
            value: id,
            checked: true,
          })),
          pageSize: 20,
        });

        if (toAdd.length === 0) {
          console.log(chalk.gray('  No models selected.'));
          return;
        }

        const selectedModels = toAdd.map(id => ({ id }));
        const { added } = importFetchedModels(resolvedName, selectedModels);
        console.log(chalk.green(`\n  ✔ Imported ${added} new model(s) to "${resolvedName}"\n`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── provider set-default ──────────────────────────────────────
  provider
    .command('set-default <name>')
    .description('Set the default provider (serves requests without a model)')
    .action(async (name) => {
      try {
        setDefaultProvider(name);
        const provider = getProvider(name);
        console.log(chalk.green(`\n✔ Default provider set to "${name}"`));
        if (provider.defaultModel) {
          console.log(chalk.gray(`  Default model: ${provider.defaultModel}`));
        } else {
          console.log(chalk.yellow(`  ⚠ No default model set on "${name}" — set one with: abproxy provider default-model ${name} <model>`));
        }
      } catch (err) {
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── provider default-model ────────────────────────────────────
  provider
    .command('default-model <name> [model]')
    .description("Set a provider's own default model (used when it is the default provider)")
    .action(async (name, modelRef) => {
      try {
        const config = getConfig();
        const resolvedName = resolveProviderName(config, name);
        if (!resolvedName) {
          console.error(chalk.red(`✖ Provider "${name}" not found`));
          return;
        }
        const provider = config.providers[resolvedName];
        const modelNames = Object.keys(provider.models || {});

        let modelName = modelRef;
        if (!modelName) {
          if (modelNames.length === 0) {
            console.error(chalk.red(`✖ Provider "${resolvedName}" has no models`));
            return;
          }
          modelName = await select({
            message: `Default model for "${resolvedName}":`,
            choices: modelNames.map(m => ({
              name: `${m}${provider.defaultModel === m ? chalk.green(' ★ current') : ''}`,
              value: m,
            })),
            loop: false,
          });
        }

        setProviderDefaultModel(resolvedName, modelName);
        console.log(chalk.green(`\n✔ Default model for "${resolvedName}": "${modelName}"`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });
}

