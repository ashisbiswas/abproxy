#!/usr/bin/env node

/**
 * abproxy — Local LLM gateway/proxy CLI
 *
 * Usage:
 *   abproxy                    # Launch interactive REPL
 *   abproxy <command>          # Run a specific command
 *   abproxy --help             # Show help
 */

import { Command } from 'commander';
import { registerProviderCommands } from '../src/cli/provider.js';
import { registerModelCommands } from '../src/cli/model.js';
import { registerGroupCommands } from '../src/cli/group.js';
import { registerSetupCommands } from '../src/cli/setup.js';
import { registerDaemonCommands } from '../src/cli/daemon.js';
import { ensureConfig } from '../src/config/manager.js';

const program = new Command();

program
  .name('abproxy')
  .description('Local LLM gateway/proxy — one endpoint, many providers, automatic failover')
  .version('1.0.0');

// Ensure config exists on any command
ensureConfig();

// Register all command groups
registerProviderCommands(program);
registerModelCommands(program);
registerGroupCommands(program);
registerSetupCommands(program);
registerDaemonCommands(program);

// If no args (or unknown args), launch REPL
if (process.argv.length <= 2) {
  // No subcommand — launch interactive REPL
  const { startRepl } = await import('../src/repl/index.js');
  startRepl();
} else {
  program.parse(process.argv);
}
