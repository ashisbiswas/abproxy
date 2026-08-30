import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfig } from '../config/manager.js';
import { logger } from '../utils/logger.js';

export function registerSetupCommands(program) {
  const setup = program.command('setup').description('Configure agents to use abproxy');

  // ─── setup claude-code ─────────────────────────────────────────
  setup
    .command('claude-code')
    .description('Configure Claude Code to use abproxy')
    .action(() => {
      const config = getConfig();
      const baseURL = `http://localhost:${config.port}`;
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

      console.log(chalk.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.cyan('  ║') + chalk.white.bold('   Claude Code Setup                 ') + chalk.cyan('║'));
      console.log(chalk.cyan('  ╚══════════════════════════════════════╝\n'));

      // Try to merge-patch settings.json
      try {
        let settings = {};
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } else {
          const settingsDir = path.dirname(settingsPath);
          if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
          }
        }

        // Merge-patch: only set the keys we own
        settings.env = settings.env || {};
        settings.env.ANTHROPIC_BASE_URL = baseURL;
        settings.env.ANTHROPIC_API_KEY = config.localApiKey;

        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        logger.success(`Patched ${settingsPath}`);
        console.log(chalk.gray(`    ANTHROPIC_BASE_URL = ${baseURL}`));
        console.log(chalk.gray(`    ANTHROPIC_API_KEY  = ${config.localApiKey}`));
      } catch (err) {
        console.log(chalk.yellow(`  Could not auto-patch: ${err.message}`));
        console.log(chalk.white('\n  Set these environment variables manually:\n'));
        console.log(chalk.green(`    export ANTHROPIC_BASE_URL="${baseURL}"`));
        console.log(chalk.green(`    export ANTHROPIC_API_KEY="${config.localApiKey}"`));
      }

      console.log('');
    });

  // ─── setup opencode ────────────────────────────────────────────
  setup
    .command('opencode')
    .description('Configure opencode to use abproxy')
    .action(() => {
      const config = getConfig();
      const baseURL = `http://localhost:${config.port}/v1`;
      const configPath = path.join(os.homedir(), '.opencode', 'config.json');

      console.log(chalk.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.cyan('  ║') + chalk.white.bold('   opencode Setup                    ') + chalk.cyan('║'));
      console.log(chalk.cyan('  ╚══════════════════════════════════════╝\n'));

      try {
        let opencodeConfig = {};
        if (fs.existsSync(configPath)) {
          opencodeConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } else {
          const configDir = path.dirname(configPath);
          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
          }
        }

        // Merge-patch: only touch the abproxy provider entry
        opencodeConfig.provider = opencodeConfig.provider || {};
        opencodeConfig.provider.abproxy = {
          name: 'abproxy',
          baseURL: baseURL,
          apiKey: config.localApiKey,
          models: [config.defaultModel || 'default'],
        };

        fs.writeFileSync(configPath, JSON.stringify(opencodeConfig, null, 2));
        logger.success(`Patched ${configPath}`);
        console.log(chalk.gray(`    baseURL = ${baseURL}`));
        console.log(chalk.gray(`    apiKey  = ${config.localApiKey}`));
      } catch (err) {
        console.log(chalk.yellow(`  Could not auto-patch: ${err.message}`));
        console.log(chalk.white('\n  Add this to your opencode config:\n'));
        console.log(chalk.gray(JSON.stringify({
          provider: {
            abproxy: {
              baseURL,
              apiKey: config.localApiKey,
            },
          },
        }, null, 2)));
      }

      console.log('');
    });

  // ─── setup codex ───────────────────────────────────────────────
  setup
    .command('codex')
    .description('Configure codex to use abproxy')
    .action(() => {
      const config = getConfig();
      const baseURL = `http://localhost:${config.port}/v1`;
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');

      console.log(chalk.cyan('\n  ╔══════════════════════════════════════╗'));
      console.log(chalk.cyan('  ║') + chalk.white.bold('   Codex Setup                       ') + chalk.cyan('║'));
      console.log(chalk.cyan('  ╚══════════════════════════════════════╝\n'));

      // TOML merge-patch without a TOML dependency: read existing, append/replace section
      try {
        let tomlContent = '';
        if (fs.existsSync(configPath)) {
          tomlContent = fs.readFileSync(configPath, 'utf-8');
        } else {
          const configDir = path.dirname(configPath);
          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
          }
        }

        const sectionHeader = '[model_providers.abproxy]';
        const sectionContent = `${sectionHeader}\nbase_url = "${baseURL}"\napi_key = "${config.localApiKey}"`;

        // Replace existing section or append
        const sectionRegex = /\[model_providers\.abproxy\][^\[]*/s;
        if (sectionRegex.test(tomlContent)) {
          tomlContent = tomlContent.replace(sectionRegex, sectionContent + '\n\n');
        } else {
          tomlContent = tomlContent.trimEnd() + '\n\n' + sectionContent + '\n';
        }

        fs.writeFileSync(configPath, tomlContent);
        logger.success(`Patched ${configPath}`);
        console.log(chalk.gray(`    base_url = "${baseURL}"`));
        console.log(chalk.gray(`    api_key  = "${config.localApiKey}"`));
      } catch (err) {
        console.log(chalk.yellow(`  Could not auto-patch: ${err.message}`));
        console.log(chalk.white(`\n  Add this to ${configPath}:\n`));
        console.log(chalk.gray(`  [model_providers.abproxy]`));
        console.log(chalk.gray(`  base_url = "${baseURL}"`));
        console.log(chalk.gray(`  api_key = "${config.localApiKey}"`));
      }

      console.log('');
    });
}
