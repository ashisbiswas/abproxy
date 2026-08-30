/**
 * Express router with auth middleware, routes, and CORS.
 */

import express from 'express';
import { getConfig } from '../config/manager.js';
import { handleProxyRequest, handleListModels, handleGetModel } from './proxy.js';
import { getAllHealth, getGlobalStats } from './health.js';
import { logger } from '../utils/logger.js';

/**
 * Create and configure the Express router
 */
export function createRouter() {
  const router = express.Router();

  // ─── CORS ──────────────────────────────────────────────────────
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // ─── Body parsing ──────────────────────────────────────────────
  router.use(express.json({ limit: '10mb' }));

  // ─── Auth middleware ───────────────────────────────────────────
  const authMiddleware = (req, res, next) => {
    // Skip auth for health/info endpoints
    if (req.path === '/health' || req.path === '/') {
      return next();
    }

    const config = getConfig();
    const authHeader = req.headers['authorization'] || '';
    const xApiKey = req.headers['x-api-key'] || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    const token = bearerToken || xApiKey;

    if (!token || token !== config.localApiKey) {
      logger.server('warn', `[auth] Rejected request — invalid API key`);
      return res.status(401).json({
        error: {
          message: 'Invalid API key. Use the localApiKey from your abproxy config.',
          type: 'authentication_error',
        },
      });
    }

    next();
  };

  router.use(authMiddleware);

  // ─── Routes ────────────────────────────────────────────────────

  // Health endpoint (no auth)
  router.get('/health', (req, res) => {
    const stats = getGlobalStats();
    const providers = getAllHealth();
    res.json({
      status: 'ok',
      uptime: stats.uptime,
      requestCount: stats.requestCount,
      providers,
    });
  });

  // Root info
  router.get('/', (req, res) => {
    const config = getConfig();
    res.json({
      name: 'abproxy',
      version: '1.0.0',
      port: config.port,
      defaultModel: config.defaultModel,
      providers: Object.keys(config.providers).length,
      groups: Object.keys(config.modelGroups).length,
    });
  });

  // OpenAI-compatible: list models
  router.get('/v1/models', handleListModels);

  // OpenAI-compatible: get single model
  router.get('/v1/models/:modelId', handleGetModel);

  // OpenAI-compatible: chat completions
  router.post('/v1/chat/completions', handleProxyRequest);

  // Anthropic-native: messages
  router.post('/v1/messages', handleProxyRequest);

  // Catch-all for unknown routes
  router.use((req, res) => {
    res.status(404).json({
      error: {
        message: `Unknown route: ${req.method} ${req.path}`,
        type: 'invalid_request_error',
      },
    });
  });

  return router;
}
