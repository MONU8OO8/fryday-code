/**
 * SSE (Server-Sent Events) bus — broadcasts live events to connected UI clients.
 *
 * Clients connect to GET /api/events (or /api/events?taskId=T-1 for a filtered stream).
 * All events are plain JSON on the `data:` field.
 *
 * Security: the server already binds to 127.0.0.1 and Express middleware checks
 * the boot token + Origin/Host header. This module assumes that check is upstream.
 */

import type { Request, Response } from 'express';

interface SseClient {
  id: string;
  taskId: string | null;
  res: Response;
}

const clients = new Map<string, SseClient>();

/** Emit an event to all connected clients (optionally filtered by taskId). */
export function sseEmit(payload: Record<string, unknown>): void {
  const data = JSON.stringify(payload);
  for (const client of clients.values()) {
    if (client.taskId && payload['taskId'] && client.taskId !== payload['taskId']) continue;
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch {
      // Client disconnected; cleanup happens in the 'close' handler
    }
  }
}

/** Express handler: GET /api/events */
export function sseHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  const clientId = `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const taskId = typeof req.query['taskId'] === 'string' ? req.query['taskId'] : null;

  clients.set(clientId, { id: clientId, taskId, res });

  // Send a keepalive comment every 25s to prevent proxy timeouts
  const keepalive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepalive);
    }
  }, 25_000);

  // Send the current client count as a hello
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  req.on('close', () => {
    clearInterval(keepalive);
    clients.delete(clientId);
  });
}

export function connectedClientCount(): number {
  return clients.size;
}
