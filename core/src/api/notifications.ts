/**
 * Notifications API — where FryDay Code tells the owner about questions, approvals and results.
 * GET    /api/notifications            — whether a Chat space is set up, and the last delivery
 * PUT    /api/notifications/chat       — { webhookUrl }: set the space's incoming webhook
 * DELETE /api/notifications/chat       — forget it
 * POST   /api/notifications/chat/test  — send a test message
 *
 * The webhook address is a secret. It can be set and removed, never read back. Changing
 * it is for the owner at the UI only.
 */

import { Router } from 'express';
import { ChatConfigError, chatStatus, postToChat, removeWebhook, saveWebhook } from '../notify/chat.js';

export const notificationsRouter = Router();

notificationsRouter.get('/', (_req, res) => {
  res.json({ chat: chatStatus() });
});

notificationsRouter.put('/chat', (req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'Set the Chat space in the FryDay Code UI' }); return; }
  try {
    res.json({ chat: saveWebhook(typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl : '') });
  } catch (err) {
    if (!(err instanceof ChatConfigError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

notificationsRouter.delete('/chat', (_req, res) => {
  if (res.locals['authVia'] !== 'cookie') { res.status(403).json({ error: 'Change the Chat space in the FryDay Code UI' }); return; }
  res.json({ chat: removeWebhook() });
});

notificationsRouter.post('/chat/test', async (_req, res) => {
  if (!chatStatus().configured) { res.status(409).json({ error: 'No Chat space is set up' }); return; }
  const delivered = await postToChat('FryDay Code is connected to this space. Questions, approvals that are waiting and results will be posted here.');
  res.json({ delivered, chat: chatStatus() });
});
