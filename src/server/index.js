/**
 * abproxy server — Express HTTP server with config hot-reload.
 * Can run as a foreground process or as a detached daemon.
 */

import express from 'express';
import { watch } from 'chokidar';
import { createRouter } from './router.js';
import { getConfig, getConfigPath, ensureConfig, formatDefaultModel } from '../config/manager.js';
import { resetHealth } from './health.js';
import { logger } from '../utils/logger.js';

let currentServer = null;

/**
 * Start the proxy server
 */
export async function startServer(configOverride = null) {
  const config = configOverride || ensureConfig();
  const app = express();

  // Trust proxy (for when running behind reverse proxy)
  app.set('trust proxy', true);

  // Mount router
  app.use(createRouter());

  return new Promise((resolve, reject) => {
    currentServer = app.listen(config.port, () => {
      const msg = `abproxy server listening on http://localhost:${config.port}`;
      logger.server('info', msg);
      console.log(`\n  🚀 ${msg}`);
      console.log(`  📋 API key: ${config.localApiKey.substring(0, 16)}...`);
      console.log(`  🎯 Default model: ${formatDefaultModel(config) || 'not set'}`);
      console.log(`  📡 Providers: ${Object.keys(config.providers).length}`);
      console.log(`  🔀 Groups: ${Object.keys(config.modelGroups).length}`);
      console.log('');

      // Set up config hot-reload
      setupHotReload();

      resolve(currentServer);
    });

    currentServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.server('error', `Port ${config.port} is already in use`);
        console.error(`\n  ✖ Port ${config.port} is already in use. Is abproxy already running?\n`);
      } else {
        logger.server('error', `Server error: ${err.message}`);
        console.error(`\n  ✖ Server error: ${err.message}\n`);
      }
      reject(err);
    });
  });
}

/**
 * Watch config file for changes and reload
 */
function setupHotReload() {
  const configPath = getConfigPath();

  const watcher = watch(configPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on('change', () => {
    try {
      // Validate the new config loads correctly
      const newConfig = getConfig();
      logger.server('info', 'Config reloaded (hot-reload)');
      console.log(`  🔄 Config reloaded`);
    } catch (err) {
      logger.server('error', `Config reload failed: ${err.message}`);
      console.error(`  ⚠ Config reload failed: ${err.message}`);
    }
  });

  // Cleanup on exit
  process.on('SIGTERM', () => {
    watcher.close();
    if (currentServer) currentServer.close();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    watcher.close();
    if (currentServer) currentServer.close();
    process.exit(0);
  });
}

/**
 * Stop the server
 */
export function stopServer() {
  if (currentServer) {
    currentServer.close();
    currentServer = null;
  }
}

// ─── Direct daemon execution ─────────────────────────────────────────
// If this file is run directly (node src/server/index.js --daemon),
// start the server immediately.
const isDaemon = process.argv.includes('--daemon');
if (isDaemon) {
  ensureConfig();
  startServer().catch(err => {
    logger.server('error', `Daemon failed to start: ${err.message}`);
    process.exit(1);
  });
}
