import chalk from 'chalk';
import { getConfig, formatDefaultModel } from '../config/manager.js';
import { listAgents, isServerAlive, findOrphanBackups } from '../agents/index.js';

const VERSION = '1.0.0';

const LOGO = `
   █████╗ ██████╗ ██████╗ ██████╗  ██████╗ ██╗  ██╗██╗   ██╗
  ██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔═══██╗╚██╗██╔╝╚██╗ ██╔╝
  ███████║██████╔╝██████╔╝██████╔╝██║   ██║ ╚███╔╝  ╚████╔╝
  ██╔══██║██╔══██╗██╔═══╝ ██╔══██╗██║   ██║ ██╔██╗   ╚██╔╝
  ██║  ██║██████╔╝██║     ██║  ██║╚██████╔╝██╔╝ ██╗   ██║
  ╚═╝  ╚═╝╚═════╝ ╚═╝     ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝   ╚═╝
`;

const orange = chalk.hex('#FF8C00');

/**
 * Display the startup banner. Callers clear the screen first.
 */
export async function showBanner() {
  console.log(orange(LOGO));

  const config = getConfig();
  const running = await isServerAlive();
  const agents = listAgents(config);

  const boxWidth = 52;
  const line = chalk.gray('─'.repeat(boxWidth));

  console.log(line);
  console.log(
    `  ${chalk.white.bold('abproxy')} ${chalk.gray('v' + VERSION)}` +
    `${' '.repeat(20)}${running ? chalk.green('● server running') : chalk.red('● server stopped')}`
  );
  console.log(line);
  console.log(
    `  ${chalk.gray('Endpoint:')}  ${chalk.cyan(`http://localhost:${config.port}`)}` +
    `    ${chalk.gray('Providers:')} ${chalk.white(Object.keys(config.providers).length)}`
  );
  console.log(
    `  ${chalk.gray('Default:')}   ${formatDefaultModel(config) ? chalk.yellow(formatDefaultModel(config)) : chalk.gray('not set')}` +
    `       ${chalk.gray('Aliases:')}  ${chalk.white(Object.keys(config.aliases || {}).length)}`
  );

  // Agent wrapper status
  const wrapped = agents.filter(a => a.wrapped);
  console.log(line);
  if (wrapped.length > 0) {
    const chips = wrapped
      .map(a => `${chalk.white(a.label)} ${running ? chalk.green('● running') : chalk.yellow('○ set — server stopped')}`)
      .join(chalk.gray('  ·  '));
    console.log(`  ${chalk.gray('Wrappers:')}  ${chips}`);
  } else {
    console.log(`  ${chalk.gray('Wrappers:')}  ${chalk.gray('none — run /setup to point your agents at abproxy')}`);
  }

  // Leftover backups from a removed/previous install — restorable
  const orphans = findOrphanBackups(config);
  if (orphans.length > 0) {
    console.log('');
    for (const o of orphans) {
      console.log(`  ${chalk.yellow('⚠ Backup found (wrapper not active):')} ${chalk.yellow(o.backupPath)}`);
    }
    console.log(`  ${chalk.gray('  Restore: /setup → agent → Stop wrapper, or: abproxy setup restore all')}`);
  }

  console.log(line);
  console.log(chalk.gray(`  Type ${chalk.white('/')} for commands, ${chalk.white('/help')} for full reference\n`));
}
