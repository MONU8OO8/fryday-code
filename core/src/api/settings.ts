/**
 * Settings API.
 * GET /api/settings — current settings, the defaults, and the choices the UI may offer
 * PUT /api/settings — change some settings ({ roles: { coder: { model, tokenLimit } }, taskTokenLimit, … })
 */

import { Router } from 'express';
import { getSettings, updateSettings, defaultSettings, SettingsError, MODELS, EFFORTS, ROLES, CURSOR_ROLES } from '../settings.js';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  res.json({
    settings: getSettings(),
    defaults: defaultSettings(),
    models: MODELS,
    efforts: EFFORTS,
    roles: ROLES,
    // Roles that may run on the Cursor CLI: read-only ones only.
    cursorRoles: CURSOR_ROLES,
    // When set, this environment variable forces one model for every agent.
    modelOverride: process.env.FRYDAY_MODEL || null,
  });
});

settingsRouter.put('/', (req, res) => {
  try {
    res.json({ settings: updateSettings(req.body) });
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    res.status(400).json({ error: err.message });
  }
});
