import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';

const LOG_DIR = path.join(os.homedir(), '.abproxy', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');
const MAX_LOG_FILES = 5;
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Ensure log directory exists
 */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Rotate logs if current file exceeds max size
 */
function rotateLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;

    // Shift existing rotated logs
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i + 1 >= MAX_LOG_FILES) {
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
      }
    }

    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // Best-effort rotation
  }
}

/**
 * Write a log line to the log file
 */
function writeToFile(level, message) {
  ensureLogDir();
  rotateLogs();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

/**
 * Logger with console + file output
 */
export const logger = {
  info(message, { file = false, console: con = true } = {}) {
    if (con) console.log(chalk.blue('ℹ'), message);
    if (file) writeToFile('info', message);
  },

  success(message, { file = false, console: con = true } = {}) {
    if (con) console.log(chalk.green('✔'), message);
    if (file) writeToFile('info', message);
  },

  warn(message, { file = false, console: con = true } = {}) {
    if (con) console.log(chalk.yellow('⚠'), message);
    if (file) writeToFile('warn', message);
  },

  error(message, { file = false, console: con = true } = {}) {
    if (con) console.error(chalk.red('✖'), message);
    if (file) writeToFile('error', message);
  },

  debug(message, { file = false, console: con = false } = {}) {
    if (con) console.log(chalk.gray('⋯'), chalk.gray(message));
    if (file) writeToFile('debug', message);
  },

  /** Server-only: log to file without console output */
  server(level, message) {
    writeToFile(level, message);
  },

  /** Get log file path */
  getLogFile() {
    return LOG_FILE;
  },

  /** Get log directory */
  getLogDir() {
    return LOG_DIR;
  },
};
