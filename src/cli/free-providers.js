/**
 * Free provider list — a curated set of free-trial/free-tier LLM gateways
 * users can add with a few keystrokes. Data lives in
 * src/data/free-providers.json (users can edit it freely; shape:
 * { providers: [{ name, url, baseUrl, protocols }] }).
 *
 * `url`     — the website/docs link (clickable in the list)
 * `baseUrl` — the API endpoint abproxy uses (defaults to url + '/v1' when
 *             the entry doesn't define one)
 */

import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { input, confirm, checkbox, select } from '@inquirer/prompts';
import ora from 'ora';
import { addProvider, importFetchedModels } from '../config/manager.js';
import { fetchProviderModels } from '../server/models-fetcher.js';

const orange = chalk.hex('#FF8C00');

const DATA_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'data', 'free-providers.json'
);

function loadList() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.providers)) return parsed.providers;
  } catch {}
  console.log(chalk.yellow('  ⚠ Could not read free-providers.json — showing empty list.'));
  return [];
}

/**
 * Resolve the API base URL for an entry: explicit baseUrl first, else
 * url + '/v1' (stripping a trailing slash).
 */
function resolveBaseUrl(entry) {
  if (entry.baseUrl && entry.baseUrl.trim()) return entry.baseUrl.trim();
  const url = (entry.url || '').trim().replace(/\/+$/, '');
  return url ? `${url}/v1` : '';
}

/**
 * OSC 8 hyperlink when the terminal supports it (Windows Terminal,
 * iTerm2, Kitty, WezTerm, …), plain cyan text otherwise.
 * Ctrl+click (or Cmd+click) opens the URL.
 */
function link(text, url) {
  if (process.env.TERM_PROGRAM || process.env.WT_SESSION) {
    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
  }
  return chalk.cyan(text);
}

/**
 * Print the numbered provider list (non-interactive — safe from /help etc.)
 */
export function printFreeProviders() {
  const list = loadList();
  console.log(chalk.cyan.bold('\n  Free provider list'));
  console.log(chalk.gray('  ────────────────────────────────────────────────'));

  if (list.length === 0) {
    console.log(chalk.gray('  (empty — edit src/data/free-providers.json)\n'));
    return [];
  }

  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const num = String(i + 1).padStart(2, ' ');
    const protos = Array.isArray(p.protocols) && p.protocols.length > 0
      ? chalk.gray(` [${p.protocols.join(' + ')}]`)
      : '';
    console.log(`  ${orange(num + '.')} ${chalk.white.bold(p.name || p.url)}${protos}`);
    console.log(`      ${link(p.url, p.url)}`);
  }
  console.log(chalk.gray('\n  Ctrl+click a URL to open it · Add one fast: /free → y → number\n'));
  return list;
}

/**
 * Interactive flow — show list, optionally add one as a real provider.
 * Wired to the main menu and /free.
 */
export async function freeProvidersMenu() {
  const list = printFreeProviders();
  if (list.length === 0) return;

  const addNow = await confirm({
    message: 'Add one of these as a provider now?',
    default: false,
  });
  if (!addNow) return;

  const pick = await input({
    message: `Provider number to add (1-${list.length}):`,
  });
  const idx = parseInt(pick, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= list.length) {
    console.log(chalk.red(`  ✖ "${pick}" is not a valid number between 1 and ${list.length}.`));
    return;
  }

  await addFreeProvider(list[idx]);
}

/**
 * Add a free provider to abproxy's config — mirrors the Providers → Add
 * Provider flow: name + base URL pre-filled from the curated entry, then
 * one or more accounts (name + API key), then model import.
 */
async function addFreeProvider(entry) {
  const defaultName = entry.name || (entry.url ? new URL(entry.url).hostname.replace(/\./g, '-') : '');
  const name = await input({ message: 'Provider name:', default: defaultName });
  if (!name.trim()) {
    console.log(chalk.gray('  Cancelled — name is required.'));
    return;
  }

  const baseURL = await input({
    message: 'Base URL:',
    default: resolveBaseUrl(entry),
  });
  if (!baseURL.trim()) {
    console.log(chalk.gray('  Cancelled — base URL is required.'));
    return;
  }

  // ── Collect one or more accounts (same as Providers → Add Provider) ──
  const accounts = [];
  let addAnother = true;
  while (addAnother) {
    const accName = await input({
      message: 'Account name:',
      default: accounts.length === 0 ? 'Default' : `Account ${accounts.length + 1}`,
    });
    const accKey = await input({ message: `  API key for "${accName}":` });
    if (!accKey.trim()) {
      console.log(chalk.yellow('  ⚠ Skipped — API key cannot be empty.'));
    } else if (accounts.some(a => a.name === accName)) {
      console.log(chalk.yellow(`  ⚠ Skipped — account "${accName}" already added.`));
    } else {
      accounts.push({ name: accName, apiKey: accKey, isDefault: accounts.length === 0 });
      console.log(chalk.green(`  ✔ Account "${accName}" added`));
    }
    addAnother = await confirm({ message: 'Add another account?', default: false });
  }

  if (accounts.length === 0) {
    console.log(chalk.red('  ✖ At least one account with an API key is required.'));
    return;
  }

  // If more than one account, let the user pick the default
  if (accounts.length > 1) {
    const defaultName2 = await select({
      message: 'Which account should be the default?',
      choices: accounts.map(a => ({ name: a.name, value: a.name })),
      loop: false,
    }).catch(() => null);
    if (defaultName2) {
      for (const a of accounts) a.isDefault = a.name === defaultName2;
    }
  }

  const protocols = Array.isArray(entry.protocols) && entry.protocols.length > 0
    ? entry.protocols
    : ['openai'];

  const providerData = {
    type: 'openai-compatible',
    baseURL,
    protocols,
    accounts,
    models: {},
    autoFetch: true,
  };

  // ── Auto-fetch models using the default account's key (same as Add Provider) ──
  const spinner = ora('Fetching available models from provider...').start();
  const fetchedModels = await fetchProviderModels(
    { type: 'openai-compatible', baseURL, accounts, protocols },
    { providerName: name, skipCache: true }
  ).catch(() => []);
  spinner.stop();

  if (fetchedModels.length > 0) {
    console.log(chalk.green(`  ✔ Found ${fetchedModels.length} model(s)\n`));
    const selectedIds = await checkbox({
      message: 'Select models to import:',
      choices: fetchedModels.map(m => ({ name: m.id, value: m.id, checked: true })),
      pageSize: 20,
    }).catch(() => []);
    for (const id of selectedIds) {
      providerData.models[id] = { realModel: id };
    }
    if (selectedIds.length > 0) {
      console.log(chalk.gray(`  Imported ${selectedIds.length} model(s)`));
    }
  } else {
    console.log(chalk.yellow('  ⚠ Could not fetch models — add them later via Providers → Sync Models.'));
  }

  try {
    addProvider(name, providerData);
    const mc = Object.keys(providerData.models).length;
    console.log(chalk.green(
      `\n  ✔ Provider "${name}" added ` +
      `(${accounts.length} account${accounts.length !== 1 ? 's' : ''}, ${mc} model${mc !== 1 ? 's' : ''})\n`
    ));
  } catch (err) {
    console.error(chalk.red(`  ✖ ${err.message}`));
  }
}
