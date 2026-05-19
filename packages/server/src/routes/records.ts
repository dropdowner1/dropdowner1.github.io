/**
 * /api/records/* and /api/rankings/* routes.
 *
 * Records writes require auth; rankings reads are public so guest
 * players can still browse the leaderboard.
 */

import { onlineMatchRequest, soloRunRequest } from '@chaindrop/shared/protocol';
import type { Request, Response, Router } from 'express';
import express from 'express';
import type { AuthService } from '../auth/AuthService';
import { type ResolvedSession, requireAuth } from '../middleware/requireAuth';
import type { RecordsService } from '../services/RecordsService';

export function recordsRouter(auth: AuthService, records: RecordsService): Router {
  const router = express.Router();

  router.post('/solo', requireAuth(auth), (req: Request, res: Response) => {
    const parsed = soloRunRequest.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'bad body' });
      return;
    }
    const session = res.locals.session as ResolvedSession;
    records.recordSoloRun(session.dbUserId, parsed.data);
    res.status(201).end();
  });

  router.post('/online', requireAuth(auth), (req: Request, res: Response) => {
    const parsed = onlineMatchRequest.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'bad body' });
      return;
    }
    const session = res.locals.session as ResolvedSession;
    records.recordOnlineMatch(session.dbUserId, parsed.data);
    res.status(201).end();
  });

  router.get('/me', requireAuth(auth), (_req: Request, res: Response) => {
    const session = res.locals.session as ResolvedSession;
    res.json(records.fetchRecordsFor(session.dbUserId));
  });

  return router;
}

export function rankingsRouter(records: RecordsService): Router {
  const router = express.Router();

  router.get('/solo', (req, res) => {
    const limit = clamp(Number(req.query.limit) || 20, 1, 100);
    res.json({ rankings: records.soloRankings(limit) });
  });

  router.get('/online', (req, res) => {
    const limit = clamp(Number(req.query.limit) || 20, 1, 100);
    res.json({ rankings: records.onlineRankings(limit) });
  });

  return router;
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
