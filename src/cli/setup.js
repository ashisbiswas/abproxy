import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import {
  listAgents,
  listAgentIds,
  getAgent,
  isServerAlive,
} from '../agents/index.js';
import { runSetupMenu, runRestoreMenu, wrapAgentAndReport } from '../agents/interactive.js';

function statusChip(agent, serverRunning) {
  if (!agent.installed && !agent.wrapped && !agent.backupExists) {
    return chalk.red('not installed');
  }
  if (agent.wrapped) {
    return serverRunning
      ? chalk.green('● wrapper running')
      : chalk.yellow('○ wrapper set — server stopped');
  }
  if (agent.backupExists) {
    return chalk.yellow('○ backup found — restorable');
  }
  return chalk.gray('not configured');
}

export function registerSetupCommands(program) {
  const setup = program.command('setup')
    .description('Configure agents to use abproxy (auto-detects installed agents)');

  // ─── setup (interactive) ───────────────────────────────────────
  setup
    .action(async () => {
      await runSetupMenu();
    });

  // ─── setup list ────────────────────────────────────────────────
  setup
    .command('list')
    .description('Show supported agents, detection and wrapper status')
    .action(async () => {
      const serverRunning = await isServerAlive();
      const agents = listAgents();

      console.log(chalk.cyan('\n  Agents and abproxy wrappers:') + (serverRunning ? chalk.green('  (server running)') : chalk.red('  (server stopped)')));
      const table = new Table({
        head: [chalk.cyan('Agent'), chalk.cyan('Status'), chalk.cyan('Config'), chalk.cyan('Backup')],
        style: { head: [], border: ['gray'] },
      });
      for (const a of agents) {
        table.push([
          chalk.white.bold(a.label) + (a.installed ? '' : chalk.red(' *')),
          statusChip(a, serverRunning),
          chalk.gray(a.installed || a.wrapped || a.backupExists ? a.configPath : a.configPath + chalk.gray(' (would be created)')),
          a.backupExists ? chalk.white(a.backupPath) : chalk.gray('—'),
        ]);
      }
      console.log(table.toString());
      console.log(chalk.gray('  * not installed — "abproxy setup <agent>" still works and creates the config.\n'));
      console.log(chalk.gray('  Wrap:   abproxy setup <agent>        (or interactive: abproxy setup)'));
      console.log(chalk.gray('  Unwrap: abproxy setup restore <agent|all>\n'));
    });

  // ─── setup restore [agent|all] ─────────────────────────────────
  setup
    .command('restore')
    .description('Stop wrapper(s) — restore original agent config(s) from backup')
    .argument('[target]', 'agent id (' + listAgentIds().join('|') + ') or "all"', null)
    .action(async (target) => {
      await runRestoreMenu(target);
    });

  // ─── setup <agent> ─────────────────────────────────────────────
  for (const id of listAgentIds()) {
    const agent = getAgent(id);
    setup
      .command(id)
      .description(`Wrap ${agent.label} — back up its config, point it at abproxy`)
      .action(async () => {
        await wrapAgentAndReport(id);
      });
  }
}
