/**
 * Shared interactive agent-setup menu.
 *
 * Used by both the REPL (/setup) and the shell (abproxy setup). Shows only
 * agents that are actually installed (or that have an active/leftover
 * wrapper), with live wrapper status, and offers wrap / stop / re-apply /
 * details actions per agent.
 */

import chalk from 'chalk';
import { select, confirm } from '@inquirer/prompts';
import {
  listAgents,
  listAgentIds,
  wrapAgent,
  unwrapAgent,
  isServerAlive,
  findOrphanBackups,
} from './index.js';

const orange = chalk.hex('#FF8C00');

// ─── Rendering helpers ───────────────────────────────────────────────

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

function printAgentDetails(agent, serverRunning) {
  console.log(`\n  ${chalk.gray('Agent:')}     ${chalk.white.bold(agent.label)}`);
  console.log(`  ${chalk.gray('Status:')}    ${statusChip(agent, serverRunning)}`);
  if (agent.installed) {
    console.log(`  ${chalk.gray('Detected:')}  ${chalk.gray(agent.via)}`);
  }
  console.log(`  ${chalk.gray('Config:')}    ${chalk.white(agent.configPath)}`);
  console.log(`  ${chalk.gray('Backup:')}    ${agent.backupExists ? chalk.white(agent.backupPath) : chalk.gray('none')}`);
  if (agent.meta) {
    console.log(`  ${chalk.gray('Wrapped:')}   ${chalk.gray(agent.meta.wrappedAt || '')} → ${chalk.cyan(agent.meta.baseURL || '')}`);
  }
  console.log('');
}

function reportWrap(result) {
  console.log(chalk.green(`\n  ✔ ${result.label} is now wrapped by abproxy`));
  console.log(`  ${chalk.gray('Config:')}   ${result.configPath}`);
  if (result.createdBackup) {
    console.log(`  ${chalk.gray('Backup:')}   ${result.backupPath} ${chalk.gray('(original preserved)')}`);
  } else {
    console.log(`  ${chalk.gray('Backup:')}   ${result.backupPath} ${chalk.gray('(kept — original from first wrap)')}`);
  }
  console.log(`  ${chalk.gray('Patched:')}`);
  console.log(`    ${chalk.gray('base URL →')} ${chalk.cyan(result.baseURL)}`);
  console.log(`    ${chalk.gray('API key  →')} ${chalk.gray(result.apiKey.slice(0, 12) + '…')}`);
  for (const notice of result.notices || []) {
    console.log(`  ${chalk.yellow('⚠ ' + notice)}`);
  }
  if (result.id === 'opencode') {
    console.log(chalk.gray('  OpenCode shows only the models captured at wrap time —'));
    console.log(chalk.gray('  run Re-apply after adding new aliases in abproxy.'));
  }
  if (result.id === 'codex') {
    console.log(chalk.gray('  Codex speaks the Responses API — abproxy serves it at /v1/responses.'));
    console.log(chalk.gray('  Restart any running Codex session to pick up the config.'));
  }
  console.log(chalk.gray('\n  Start the server if it is not running: abproxy start'));
  console.log(chalk.gray('  In the agent, use an alias name (or "default") as the model.\n'));
}

function reportUnwrap(result) {
  if (result.restored && result.from === 'backup') {
    console.log(chalk.green(`\n  ✔ Wrapper stopped — ${result.label}'s original config restored`));
    console.log(`  ${chalk.gray('Restored:')}  ${result.configPath}`);
    console.log(`  ${chalk.gray('Removed:')}   ${result.backupPath}\n`);
  } else if (result.restored && result.from === 'strip') {
    console.log(chalk.green(`\n  ✔ Wrapper stopped — abproxy keys removed from ${result.label}'s config`));
    console.log(chalk.gray('  (No backup existed, so only the abproxy keys were stripped.)\n'));
  } else {
    console.log(chalk.yellow(`\n  ⚠ Nothing to restore for ${result.label} — no wrapper and no backup found.\n`));
  }
}

// ─── Per-agent actions ───────────────────────────────────────────────

async function wrapFlow(agent) {
  const configPath = agent.configPath;
  console.log(`\n  ${chalk.gray('Config:')}  ${chalk.white(configPath)}`);
  console.log(`  ${chalk.gray('Backup:')}  ${chalk.white(agent.backupPath)} ${chalk.gray('(created before anything is changed)')}`);
  const yes = await confirm({
    message: `Wrap ${agent.label} — back up its config and point it at abproxy?`,
    default: true,
  });
  if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }

  try {
    reportWrap(wrapAgent(agent.id));
  } catch (err) {
    console.log(chalk.red(`  ✖ Could not patch config: ${err.message}`));
    console.log(chalk.gray('  Nothing was changed. Set the env/config manually instead (see README).'));
  }
}

async function unwrapFlow(agent) {
  const yes = await confirm({
    message: `Stop the wrapper for ${agent.label} and restore its original config from the backup?`,
    default: true,
  });
  if (!yes) { console.log(chalk.gray('  Cancelled.')); return; }
  reportUnwrap(unwrapAgent(agent.id));
}

async function wrappedActions(agent, serverRunning) {
  printAgentDetails(agent, serverRunning);
  let choice;
  try {
    choice = await select({
      message: `${agent.label} wrapper:`,
      choices: [
        { name: `${chalk.cyan('Stop wrapper'.padEnd(16))} ${chalk.gray('Restore original config from the backup')}`, value: 'stop' },
        { name: `${chalk.cyan('Re-apply'.padEnd(16))} ${chalk.gray('Update URL/key (e.g. after changing the port)')}`, value: 'reapply' },
        { name: `${chalk.cyan('Details'.padEnd(16))} ${chalk.gray('Paths, backup, wrapped-at')}`, value: 'details' },
        { name: chalk.gray('← Back'), value: 'back' },
      ],
      loop: false,
    });
  } catch (err) {
    if (err.name === 'ExitPromptError') return;
    throw err;
  }

  switch (choice) {
    case 'stop':    await unwrapFlow(agent); break;
    case 'reapply':
      try {
        reportWrap(wrapAgent(agent.id));
      } catch (err) {
        console.log(chalk.red(`  ✖ Could not re-apply: ${err.message}`));
      }
      break;
    case 'details': printAgentDetails(agent, serverRunning); break;
    default: break;
  }
}

// ─── Menus ───────────────────────────────────────────────────────────

/**
 * Main setup menu. Loops until Back/Escape. Only agents that are installed
 * (or that have wrapper state / a leftover backup) are listed.
 */
export async function runSetupMenu() {
  while (true) {
    const serverRunning = await isServerAlive();
    const agents = listAgents()
      .filter(a => a.installed || a.wrapped || a.backupExists);

    const orphans = findOrphanBackups();
    if (orphans.length > 0) {
      console.log(chalk.yellow('\n  ⚠ Restorable backup(s) found from a previous abproxy setup:'));
      for (const o of orphans) {
        console.log(chalk.yellow(`    ${o.backupPath}`));
      }
      console.log(chalk.gray('  Restore via the agent below (Stop wrapper) or: abproxy setup restore all'));
    }

    if (agents.length === 0) {
      console.log(chalk.yellow('\n  No supported coding agents detected on this machine.'));
      console.log(chalk.gray('  Looked for:'));
      console.log(chalk.gray('    Claude Code  — "claude" on PATH, or ~/.claude'));
      console.log(chalk.gray('    OpenCode     — "opencode" on PATH, or ~/.config/opencode'));
      console.log(chalk.gray('    Codex        — "codex" on PATH, or ~/.codex'));
      console.log(chalk.gray('  Install one, then re-run setup. You can also configure manually (see README).\n'));
      return;
    }

    let choice;
    try {
      choice = await select({
        message: 'Setup — select agent (only installed agents are shown):',
        choices: [
          ...agents.map(a => ({
            name: `${a.label.padEnd(13)} ${statusChip(a, serverRunning)}`,
            value: a.id,
          })),
          { name: chalk.gray('← Back'), value: null },
        ],
        loop: false,
        pageSize: agents.length + 1,
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
      return;
    }
    if (choice === null) return;

    const agent = agents.find(a => a.id === choice);
    try {
      if (agent.wrapped) {
        await wrappedActions(agent, serverRunning);
      } else {
        await wrapFlow(agent);
      }
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
    }
  }
}

/**
 * Restore original agent configs. `target` is an agent id, 'all', or null
 * (interactive picker over wrapped/backup agents).
 */
export async function runRestoreMenu(target = null) {
  const agents = listAgents().filter(a => a.wrapped || a.backupExists);

  if (agents.length === 0) {
    console.log(chalk.gray('\n  No wrappers or backups found — nothing to restore.\n'));
    return;
  }

  let targets;
  if (target === 'all') {
    targets = agents;
  } else if (target && listAgentIds().includes(target)) {
    targets = agents.filter(a => a.id === target);
    if (targets.length === 0) {
      console.log(chalk.yellow(`\n  ⚠ ${target} has no wrapper or backup to restore.\n`));
      return;
    }
  } else if (!target) {
    let choice;
    try {
      choice = await select({
        message: 'Restore original config for:',
        choices: [
          ...agents.map(a => ({
            name: `${a.label.padEnd(13)} ${chalk.gray(a.backupPath)}`,
            value: a.id,
          })),
          { name: `${chalk.cyan('All'.padEnd(13))} ${chalk.gray('Restore every wrapper/backup')}`, value: 'all' },
          { name: chalk.gray('← Back'), value: null },
        ],
        loop: false,
      });
    } catch (err) {
      if (err.name === 'ExitPromptError') return;
      console.error(chalk.red(`  ✖ ${err.message}`));
      return;
    }
    if (choice === null) return;
    if (choice === 'all') { await runRestoreMenu('all'); return; }
    targets = agents.filter(a => a.id === choice);
  } else {
    console.log(chalk.red(`\n  ✖ Unknown agent "${target}". Known: ${listAgentIds().join(', ')}\n`));
    return;
  }

  for (const agent of targets) {
    reportUnwrap(unwrapAgent(agent.id));
  }
}

/**
 * Wrap one agent by id and print the result (used for direct commands like
 * `abproxy setup claude-code` or `/setup claude-code`).
 */
export async function wrapAgentAndReport(id) {
  const known = listAgentIds();
  if (!known.includes(id)) {
    console.log(chalk.red(`\n  ✖ Unknown agent "${id}". Known agents: ${known.join(', ')}\n`));
    return;
  }
  const agent = listAgents().find(a => a.id === id);
  if (!agent.installed && !agent.wrapped && !agent.backupExists) {
    console.log(chalk.yellow(`\n  ⚠ ${agent.label} does not appear to be installed on this machine.`));
    console.log(chalk.gray(`    Looked for: "on PATH" and ${agent.configCandidates()[0]}`));
    const yes = await confirm({ message: 'Wrap it anyway (config will be created)?', default: false });
    if (!yes) { console.log(chalk.gray('  Cancelled.\n')); return; }
  }
  try {
    reportWrap(wrapAgent(id));
  } catch (err) {
    console.log(chalk.red(`  ✖ Could not patch config: ${err.message}`));
    console.log(chalk.gray('  Nothing was changed. Set the env/config manually instead (see README).'));
  }
}

export { orange };
