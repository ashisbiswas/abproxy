import readline from 'node:readline';
import chalk from 'chalk';
import { showBanner } from './banner.js';
import { commands, matchCommand, showMainMenu } from './commands.js';
import { ensureConfig } from '../config/manager.js';

const orange = chalk.hex('#FF8C00');
const PROMPT = orange('  abproxy') + chalk.gray(' › ');

/**
 * Launch the interactive REPL with raw keypress detection.
 * Typing `/` instantly opens the command picker (no Enter needed).
 */
export async function startRepl() {
  ensureConfig();
  showBanner();

  let inputBuffer = '';
  let busy = false;

  // Keep the process alive no matter what
  process.on('uncaughtException', (err) => {
    console.error(chalk.red(`  ✖ ${err.message}`));
    resumeRawMode();
    writePrompt();
  });

  function enterRawMode() {
    try {
      process.stdin.resume();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
    } catch {}
  }

  function exitRawMode() {
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch {}
  }

  function resumeRawMode() {
    try {
      process.stdin.resume();
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
    } catch {}
  }

  /**
   * Run a handler with raw mode temporarily disabled (for inquirer prompts).
   * Always restores raw mode and re-shows the prompt afterwards.
   */
  async function runWithPromptMode(fn) {
    busy = true;
    exitRawMode();

    try {
      await fn();
    } catch (err) {
      if (err.name !== 'ExitPromptError') {
        console.error(chalk.red(`  ✖ ${err.message}`));
      }
    }

    // Always restore — this is the key fix
    resumeRawMode();
    busy = false;
    writePrompt();
  }

  // Enable raw mode
  enterRawMode();
  readline.emitKeypressEvents(process.stdin);

  // Prevent stdin 'end' from killing the process
  process.stdin.on('end', () => {
    // Re-open stdin to keep alive
    resumeRawMode();
  });

  writePrompt();

  process.stdin.on('keypress', async (str, key) => {
    if (busy) return;

    // ── Ctrl+C ──────────────────────────────────────────────────
    if (key && key.ctrl && key.name === 'c') {
      if (inputBuffer.length > 0) {
        clearLine();
        inputBuffer = '';
        writePrompt();
      } else {
        process.stdout.write('\n');
        console.log(chalk.gray('  Use /exit or Ctrl+D to quit\n'));
        writePrompt();
      }
      return;
    }

    // ── Ctrl+D ──────────────────────────────────────────────────
    if (key && key.ctrl && key.name === 'd') {
      process.stdout.write('\n');
      console.log(chalk.gray('\n  Goodbye! 👋\n'));
      process.exit(0);
    }

    // ── Backspace ───────────────────────────────────────────────
    if (key && (key.name === 'backspace' || key.name === 'delete')) {
      if (inputBuffer.length > 0) {
        inputBuffer = inputBuffer.slice(0, -1);
        process.stdout.write('\b \b');
      }
      return;
    }

    // ── Enter ───────────────────────────────────────────────────
    if (key && key.name === 'return') {
      process.stdout.write('\n');
      const trimmed = inputBuffer.trim();
      inputBuffer = '';

      if (!trimmed) {
        writePrompt();
        return;
      }

      if (trimmed.startsWith('/')) {
        const match = matchCommand(trimmed);
        if (match) {
          // Commands that don't need interactive prompts can run directly
          await runWithPromptMode(() => match.command.handler(match.args));
        } else {
          const partial = commands.filter(c => c.name.includes(trimmed.slice(1)));
          if (partial.length > 0) {
            console.log(chalk.yellow(`\n  Did you mean?`));
            for (const c of partial) {
              console.log(`    ${orange(c.name)}  ${chalk.gray(c.desc)}`);
            }
            console.log('');
          } else {
            console.log(chalk.red(`  Unknown command: ${trimmed}`));
            console.log(chalk.gray(`  Type /help for available commands\n`));
          }
          writePrompt();
        }
      } else {
        console.log(chalk.gray(`  Type / for commands or /help for reference`));
        writePrompt();
      }
      return;
    }

    // ── `/` on empty buffer → instant main menu ─────────────────
    if (str === '/' && inputBuffer.length === 0) {
      process.stdout.write('/\n');
      inputBuffer = '';
      await runWithPromptMode(() => showMainMenu());
      return;
    }

    // ── Normal character ────────────────────────────────────────
    if (str && !key?.ctrl && !key?.meta && str.length === 1) {
      inputBuffer += str;
      process.stdout.write(str);
    }
  });
}

function writePrompt() {
  process.stdout.write(PROMPT);
}

function clearLine() {
  process.stdout.write('\r\x1b[K');
}
