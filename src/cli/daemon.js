import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { getConfig, formatDefaultModel } from '../config/manager.js';
import { logger } from '../utils/logger.js';

const PID_FILE = path.join(os.homedir(), '.abproxy', 'daemon.pid');
const LOG_FILE = path.join(os.homedir(), '.abproxy', 'logs', 'daemon.log');

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
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

export function registerDaemonCommands(program) {

  // ─── start ─────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start the proxy daemon')
    .option('--foreground', 'Run in foreground (don\'t daemonize)')
    .action(async (opts) => {
      const config = getConfig();

      // Check if already running
      const existingPid = readPid();
      if (existingPid && isProcessRunning(existingPid)) {
        console.log(chalk.yellow(`  abproxy is already running (PID ${existingPid})`));
        return;
      }

      if (opts.foreground) {
        // Run server in-process
        console.log(chalk.cyan(`\n  Starting abproxy server on port ${config.port} (foreground)...\n`));
        const { startServer } = await import('../server/index.js');
        await startServer(config);
      } else {
        // Spawn detached daemon
        const serverPath = path.resolve(
          path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
          '../server/index.js'
        );

        const logDir = path.dirname(LOG_FILE);
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }

        const out = fs.openSync(LOG_FILE, 'a');
        const err = fs.openSync(LOG_FILE, 'a');

        const child = spawn(process.execPath, [serverPath, '--daemon'], {
          detached: true,
          stdio: ['ignore', out, err],
          env: { ...process.env },
        });

        child.unref();

        // Write PID file
        const pidDir = path.dirname(PID_FILE);
        if (!fs.existsSync(pidDir)) {
          fs.mkdirSync(pidDir, { recursive: true });
        }
        fs.writeFileSync(PID_FILE, child.pid.toString());

        console.log(chalk.green(`\n  ✔ abproxy daemon started (PID ${child.pid})`));
        console.log(chalk.gray(`    Listening on http://localhost:${config.port}`));
        console.log(chalk.gray(`    Logs: ${LOG_FILE}`));
        console.log(chalk.gray(`    PID file: ${PID_FILE}\n`));
      }
    });

  // ─── stop ──────────────────────────────────────────────────────
  program
    .command('stop')
    .description('Stop the proxy daemon')
    .action(() => {
      const pid = readPid();
      if (!pid || !isProcessRunning(pid)) {
        console.log(chalk.yellow('  abproxy is not running.'));
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        return;
      }

      try {
        process.kill(pid, 'SIGTERM');
        fs.unlinkSync(PID_FILE);
        console.log(chalk.green(`\n  ✔ abproxy daemon stopped (PID ${pid})\n`));
      } catch (err) {
        console.error(chalk.red(`  ✖ Failed to stop daemon: ${err.message}`));
      }
    });

  // ─── restart ───────────────────────────────────────────────────
  program
    .command('restart')
    .description('Restart the proxy daemon')
    .action(async () => {
      const pid = readPid();
      if (pid && isProcessRunning(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
          if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
          console.log(chalk.gray(`  Stopped old daemon (PID ${pid})`));
        } catch {}
        // Small delay for port release
        await new Promise(r => setTimeout(r, 1000));
      }

      // Start fresh
      const config = getConfig();
      const serverPath = path.resolve(
        path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
        '../server/index.js'
      );

      const logDir = path.dirname(LOG_FILE);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const out = fs.openSync(LOG_FILE, 'a');
      const err = fs.openSync(LOG_FILE, 'a');

      const child = spawn(process.execPath, [serverPath, '--daemon'], {
        detached: true,
        stdio: ['ignore', out, err],
        env: { ...process.env },
      });

      child.unref();
      fs.writeFileSync(PID_FILE, child.pid.toString());

      console.log(chalk.green(`\n  ✔ abproxy daemon restarted (PID ${child.pid})`));
      console.log(chalk.gray(`    Listening on http://localhost:${config.port}\n`));
    });

  // ─── status ────────────────────────────────────────────────────
  program
    .command('status')
    .description('Check daemon status')
    .action(async () => {
      const config = getConfig();
      const pid = readPid();
      const running = pid && isProcessRunning(pid);

      console.log(chalk.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.cyan('  ║') + chalk.white.bold('   abproxy status                    ') + chalk.cyan('║'));
      console.log(chalk.cyan('  ╚══════════════════════════════════════╝\n'));

      console.log(
        `  ${chalk.gray('Server:')}    ${running ? chalk.green('● running') : chalk.red('● stopped')}` +
        (running ? chalk.gray(` (PID ${pid})`) : '')
      );
      console.log(`  ${chalk.gray('Port:')}      ${chalk.white(config.port)}`);
      console.log(`  ${chalk.gray('Endpoint:')}  ${chalk.white(`http://localhost:${config.port}`)}`);
      console.log(`  ${chalk.gray('Default:')}   ${formatDefaultModel(config) ? chalk.white(formatDefaultModel(config)) : chalk.gray('not set')}`);
      console.log(`  ${chalk.gray('Providers:')} ${chalk.white(Object.keys(config.providers).length)}`);
      console.log(`  ${chalk.gray('Groups:')}    ${chalk.white(Object.keys(config.modelGroups).length)}`);
      console.log(`  ${chalk.gray('API key:')}   ${chalk.gray(config.localApiKey.substring(0, 12) + '...')}`);

      // If running, try to fetch /health from the server
      if (running) {
        try {
          const resp = await fetch(`http://localhost:${config.port}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (resp.ok) {
            const health = await resp.json();
            if (health.uptime) {
              const uptimeStr = formatUptime(health.uptime);
              console.log(`  ${chalk.gray('Uptime:')}    ${chalk.white(uptimeStr)}`);
            }
            if (health.requestCount !== undefined) {
              console.log(`  ${chalk.gray('Requests:')}  ${chalk.white(health.requestCount)}`);
            }
            if (health.providers) {
              console.log(`\n  ${chalk.gray('Provider Health:')}`);
              for (const [name, status] of Object.entries(health.providers)) {
                const statusStr = status.healthy
                  ? chalk.green('● healthy')
                  : chalk.red(`● ${status.reason || 'unhealthy'}`);
                console.log(`    ${chalk.white(name)}: ${statusStr}`);
              }
            }
          }
        } catch {
          // Server might not respond to /health yet
        }
      }

      console.log('');
    });

  // ─── logs ──────────────────────────────────────────────────────
  program
    .command('logs')
    .description('View daemon logs')
    .option('-f, --follow', 'Follow log output')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action(async (opts) => {
      if (!fs.existsSync(LOG_FILE)) {
        console.log(chalk.yellow('  No logs found.'));
        return;
      }

      if (opts.follow) {
        // Tail -f behavior
        console.log(chalk.gray(`  Following ${LOG_FILE} (Ctrl+C to stop)\n`));
        const { spawn: spawnCmd } = await import('node:child_process');

        // Use PowerShell Get-Content -Wait on Windows
        const isWindows = process.platform === 'win32';
        let tail;
        if (isWindows) {
          tail = spawnCmd('powershell', [
            '-Command',
            `Get-Content -Path "${LOG_FILE}" -Tail ${opts.lines} -Wait`,
          ], { stdio: 'inherit' });
        } else {
          tail = spawnCmd('tail', ['-f', '-n', opts.lines, LOG_FILE], { stdio: 'inherit' });
        }

        tail.on('close', () => process.exit(0));
        process.on('SIGINT', () => {
          tail.kill();
          process.exit(0);
        });
      } else {
        const content = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = content.trim().split('\n');
        const count = parseInt(opts.lines, 10);
        const tail = lines.slice(-count);
        console.log('\n' + tail.join('\n') + '\n');
      }
    });
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
