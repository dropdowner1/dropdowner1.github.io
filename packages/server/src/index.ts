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
import { TechmanaService } from './auth/TechmanaService';
import { config } from './config';
import { openDatabase } from './db/Database';
import { LobbyRoom } from './rooms/LobbyRoom';
import { MatchRoom } from './rooms/MatchRoom';
import { authRouter } from './routes/auth';
import { rankingsRouter, recordsRouter } from './routes/records';
import { syncRouter, techmanaRouter } from './routes/techmana';
import { RecordsService } from './services/RecordsService';
import { logger } from './util/logger';

const app = express();
const db = openDatabase({ path: config.databasePath });
const authService = new AuthService(db);
const recordsService = new RecordsService(db);
const techmanaService = new TechmanaService(db);

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

// Everything except the cloud save is small. `/api/sync` mounts its own
// parser with a 1MB limit, so this one has to step aside for it —
// otherwise the first parser to see the request rejects it with 413 and
// the larger limit downstream never gets a say.
const smallJson = express.json({ limit: '32kb' });
app.use((req, res, next) => {
  if (req.path.startsWith('/api/sync')) return next();
  smallJson(req, res, next);
});
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    protocolVersion: PROTOCOL_VERSION,
  });
});

// テクマナSSOは `/api/auth/techmana/*`。汎用の `/api/auth` より先に
// 積んで、どちらが処理するかを一目で分かるようにしておく。
app.use('/api/auth/techmana', techmanaRouter(authService, techmanaService));
app.use('/api/auth', authRouter(authService));
app.use('/api/me', (_req, res, next) => {
  // /api/me is exposed under /api/auth/me; keep the legacy mount in
  // case anything in docs refers to the bare path.
  res.redirect(307, '/api/auth/me');
  void next; // ignore
});
app.use('/api/records', recordsRouter(authService, recordsService));
app.use('/api/rankings', rankingsRouter(recordsService));
// クラウドセーブ。中身はテクマナ側に保管し、ここは中継のみ。
// セーブ本体は他のAPIより大きくなりうるので、この経路だけ上限を上げる
// (テクマナ側の上限1MBに合わせる)。
app.use('/api/sync', express.json({ limit: '1mb' }), syncRouter(authService, techmanaService));

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
