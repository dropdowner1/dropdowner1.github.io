/**
 * ChainDrop server entry point. See D6 §4.
 *
 * One process hosts both the Colyseus realtime layer (lobby /
 * match rooms over WebSocket) and the HTTP API for accounts +
 * persisted records. Express drives the HTTP side; Colyseus
 * attaches its WebSocketTransport to the same HTTP server.
 */
import { createServer } from 'node:http';
import { PROTOCOL_VERSION } from '@chaindrop/shared';
import { Server } from '@colyseus/core';
import { monitor } from '@colyseus/monitor';
import { WebSocketTransport } from '@colyseus/ws-transport';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import basicAuth from 'express-basic-auth';
import { AuthService } from './auth/AuthService';
import { config } from './config';
import { openDatabase } from './db/Database';
import { LobbyRoom } from './rooms/LobbyRoom';
import { MatchRoom } from './rooms/MatchRoom';
import { authRouter } from './routes/auth';
import { rankingsRouter, recordsRouter } from './routes/records';
import { RecordsService } from './services/RecordsService';
import { logger } from './util/logger';

const app = express();
const db = openDatabase({ path: config.databasePath });
const authService = new AuthService(db);
const recordsService = new RecordsService(db);

app.use(
  cors({
    // Cookies cross the wire only when both `origin` is a real string
    // (no `*`) AND credentials are allowed; configure both knobs.
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (config.allowedOrigins.includes('*')) return callback(null, true);
      if (config.allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: '32kb' }));
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
  });
});

app.use('/api/auth', authRouter(authService));
app.use('/api/me', (_req, res, next) => {
  // /api/me is exposed under /api/auth/me; keep the legacy mount in
  // case anything in docs refers to the bare path.
  res.redirect(307, '/api/auth/me');
  void next; // ignore
});
app.use('/api/records', recordsRouter(authService, recordsService));
app.use('/api/rankings', rankingsRouter(recordsService));

if (config.monitor.enabled) {
  app.use(
    '/monitor',
    basicAuth({
      users: { [config.monitor.user]: config.monitor.pass },
      challenge: true,
    }),
    monitor(),
  );
}

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('lobby', LobbyRoom);
// `filterBy(['roomId'])` lets the client `joinById(roomId)` and have
// Colyseus route to the MatchRoom whose `onCreate` set this exact id.
gameServer.define('match', MatchRoom).filterBy(['roomId']);

gameServer.listen(config.port);
logger.info({ port: config.port, protocolVersion: PROTOCOL_VERSION }, 'server listening');
