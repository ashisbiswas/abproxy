import chalk from 'chalk';
import { getConfig } from '../config/manager.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
 * Display the startup banner
 */
export function showBanner() {
  console.log(orange(LOGO));

  const config = getConfig();
  const pid = readDaemonPid();
  const running = pid ? isProcessRunning(pid) : false;

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
    `  ${chalk.gray('Default:')}   ${config.defaultModel ? chalk.yellow(config.defaultModel) : chalk.gray('not set')}` +
    `       ${chalk.gray('Groups:')}    ${chalk.white(Object.keys(config.modelGroups).length)}`
  );
  console.log(line);
  console.log(chalk.gray(`  Type ${chalk.white('/')} for commands, ${chalk.white('/help')} for full reference\n`));
}

function readDaemonPid() {
  try {
    const pidFile = path.join(os.homedir(), '.abproxy', 'daemon.pid');
    if (fs.existsSync(pidFile)) {
      return parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    }
  } catch {}
  return null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
