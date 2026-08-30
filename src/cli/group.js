import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { input, select, confirm, checkbox } from '@inquirer/prompts';
import {
  addGroup,
  editGroup,
  deleteGroup,
  listGroups,
  listModels,
  listProviders,
  getConfig,
} from '../config/manager.js';

export function registerGroupCommands(program) {
  const group = program.command('group').description('Manage model groups (failover sets)');

  // ─── group create ──────────────────────────────────────────────
  group
    .command('create <name>')
    .description('Create a model group')
    .option('-m, --members <members>', 'Comma-separated provider:model pairs')
    .action(async (name, opts) => {
      try {
        let members;

        if (opts.members) {
          members = opts.members.split(',').map(m => m.trim());
        } else {
          // Interactive: show available provider:model pairs
          const models = listModels();
          if (models.length === 0) {
            console.error(chalk.red('✖ No models configured. Add models first.'));
            return;
          }

          const choices = models.map(m => ({
            name: `${m.provider}:${m.name} (→ ${m.realModel})`,
            value: `${m.provider}:${m.name}`,
          }));

          members = await checkbox({
            message: 'Select members for this group:',
            choices,
          });

          if (members.length === 0) {
            console.log(chalk.gray('  No members selected. Cancelled.'));
            return;
          }
        }

        const strategy = await select({
          message: 'Failover strategy:',
          choices: [
            { name: 'Failover (try in order)', value: 'failover' },
            { name: 'Round-robin (spread load)', value: 'round-robin' },
          ],
        });

        addGroup(name, { members, strategy });
        console.log(chalk.green(`\n✔ Group "${name}" created with ${members.length} member(s)`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── group edit ────────────────────────────────────────────────
  group
    .command('edit <name>')
    .description('Edit a model group')
    .action(async (name) => {
      try {
        const config = getConfig();
        const existing = config.modelGroups[name];
        if (!existing) {
          console.error(chalk.red(`✖ Group "${name}" not found`));
          return;
        }

        const models = listModels();
        const choices = models.map(m => ({
          name: `${m.provider}:${m.name} (→ ${m.realModel})`,
          value: `${m.provider}:${m.name}`,
          checked: existing.members.includes(`${m.provider}:${m.name}`),
        }));

        const members = await checkbox({
          message: 'Select members for this group:',
          choices,
        });

        const strategy = await select({
          message: 'Failover strategy:',
          choices: [
            { name: 'Failover (try in order)', value: 'failover' },
            { name: 'Round-robin (spread load)', value: 'round-robin' },
          ],
          default: existing.strategy,
        });

        editGroup(name, { members, strategy });
        console.log(chalk.green(`\n✔ Group "${name}" updated`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });

  // ─── group list ────────────────────────────────────────────────
  group
    .command('list')
    .description('List all model groups')
    .action(() => {
      const groups = listGroups();
      const entries = Object.entries(groups);

      if (entries.length === 0) {
        console.log(chalk.yellow('\n  No model groups configured.\n'));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan('Group'),
          chalk.cyan('Members'),
          chalk.cyan('Strategy'),
          chalk.cyan('Default'),
        ],
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
    });

  // ─── group delete ──────────────────────────────────────────────
  group
    .command('delete <name>')
    .description('Delete a model group')
    .action(async (name) => {
      try {
        const yes = await confirm({
          message: `Delete group "${name}"?`,
          default: false,
        });
        if (!yes) {
          console.log(chalk.gray('  Cancelled.'));
          return;
        }

        deleteGroup(name);
        console.log(chalk.green(`\n✔ Group "${name}" deleted`));
      } catch (err) {
        if (err.name === 'ExitPromptError') return;
        console.error(chalk.red(`✖ ${err.message}`));
      }
    });
}
