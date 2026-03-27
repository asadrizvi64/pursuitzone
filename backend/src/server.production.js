// ═══════════════════════════════════════════════════════════════
// PURSUIT ZONE — Production Server
// Horizontally scalable with Socket.io Redis adapter
// ═══════════════════════════════════════════════════════════════

import cluster from 'node:cluster';
import os from 'node:os';
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Pool } from 'pg';
import Redis from 'ioredis';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import admin from 'firebase-admin';
import { createTerminus } from '@godaddy/terminus';
import pino from 'pino';

import { setupChaseRoutes, setupUserRoutes, setupNotificationRoutes, setupMatchmakingRoutes } from './routes/chase.js';
import { setupAuthRoutes } from './routes/auth.js';
import { setupWalletRoutes } from './routes/wallet.js';
import { MatchmakingService } from './services/matchmaking.js';
import { NotificationService } from './services/notification.js';
import { GeofenceService } from './services/geofence.js';
import { AntiCollusionService } from './services/antiCollusion.js';
import { EconomyService } from './services/economy.js';
import { ChaseEngine } from './services/chaseEngine.js';
import { GPSProcessor } from './services/gpsProcessor.js';
import { setupSocketHandlers } from './sockets/chaseSocket.js';
import { authMiddleware } from './middleware/auth.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty' } : undefined,
});

// ═══════════════════════════════════════════════════════
// CLUSTER MODE — Fork workers per CPU for max throughput
// ═══════════════════════════════════════════════════════
const WORKER_COUNT = parseInt(process.env.WORKER_COUNT) || Math.min(os.cpus().length, 4);
const ROLE = process.env.SERVER_ROLE || 'api'; // 'api' | 'worker' | 'gps'

if (cluster.isPrimary && process.env.ENABLE_CLUSTER === 'true') {
  logger.info(`Primary ${process.pid}: forking ${WORKER_COUNT} workers (role: ${ROLE})`);
  for (let i = 0; i < WORKER_COUNT; i++) {
    cluster.fork();
  }
  cluster.on('exit', (worker, code) => {
    logger.warn(`Worker ${worker.process.pid} died (code: ${code}). Restarting...`);
    cluster.fork();
  });
} else {
  startServer();
}

async function startServer() {
  const PORT = parseInt(process.env.PORT) || 4000;

  // ── Database connection pool ──────────────────
  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX) || 20,
    min: parseInt(process.env.DB_POOL_MIN) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Use read replica for heavy SELECT queries
    ...(process.env.DATABASE_READ_URL && { 
      // We'll create a separate pool for reads
    }),
  });

  // Read replica pool (for GPS queries, browse chases, etc.)
  const dbRead = process.env.DATABASE_READ_URL
    ? new Pool({
        connectionString: process.env.DATABASE_READ_URL,
        max: 30,
        min: 5,
        idleTimeoutMillis: 30000,
      })
    : db; // Fallback to primary if no replica

  // ── Redis (application state) ─────────────────
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    lazyConnect: true,
    enableReadyCheck: true,
    reconnectOnError: (err) => err.message.includes('READONLY'),
  });
  await redis.connect();

  // ── Redis for Socket.io adapter (pub/sub) ─────
  // Separate connection pair for the Socket.io Redis adapter
  // This enables Socket.io to broadcast across multiple server instances
  const pubClient = createClient({ url: process.env.REDIS_URL });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);

  // ── Firebase ──────────────────────────────────
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  }

  // ── Express ───────────────────────────────────
  const app = express();
  const server = http.createServer(app);

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  // Stripe webhook needs raw body
  app.use('/api/wallet/webhook', express.raw({ type: 'application/json' }));

  // Rate limiting per IP
  app.use('/api/', rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
  }));

  // Store db in app for middleware access
  app.locals.db = db;

  // ── Socket.io with Redis adapter ──────────────
  const io = new SocketIO(server, {
    cors: { origin: '*' },
    transports: ['websocket'],         // WebSocket only for performance
    pingTimeout: 30000,
    pingInterval: 10000,
    maxHttpBufferSize: 1e6,            // 1MB max message
    perMessageDeflate: false,          // Disable compression for GPS speed
    // Connection state recovery — reconnect without losing room subscriptions
    connectionStateRecovery: {
      maxDisconnectionDuration: 120000, // 2 minutes
      skipMiddlewares: true,
    },
  });

  // ═══════════════════════════════════════════════
  // REDIS ADAPTER — This is the key to horizontal scaling
  // Every Socket.io instance shares events through Redis pub/sub
  // So a GPS update on server-1 reaches clients on server-2
  // ═══════════════════════════════════════════════
  io.adapter(createAdapter(pubClient, subClient));

  // Socket authentication
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const user = await authMiddleware.verifyToken(token, db);
      socket.userId = user.id;
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('Authentication failed'));
    }
  });

  // ── Services ──────────────────────────────────
  const economy = new EconomyService(db);
  const notification = new NotificationService(db, redis, admin);
  const geofence = new GeofenceService(db, redis);
  const antiCollusion = new AntiCollusionService(db);
  const matchmaking = new MatchmakingService(db, redis, notification);
  const gpsProcessor = new GPSProcessor(db, dbRead, redis);
  const chaseEngine = new ChaseEngine(db, redis, economy, notification, geofence, antiCollusion, matchmaking);

  // Give services access to Socket.io
  notification.setIO(io);
  geofence.setIO(io);
  chaseEngine.setIO(io);

  // Socket handlers
  setupSocketHandlers(io, chaseEngine, geofence, antiCollusion, notification, gpsProcessor);

  // ── Routes ────────────────────────────────────
  app.use('/api/auth', setupAuthRoutes(db));
  app.use('/api/users', setupUserRoutes(db, economy));
  app.use('/api/chases', setupChaseRoutes(dbRead, chaseEngine, economy));
  app.use('/api/notifications', setupNotificationRoutes(db, notification));
  app.use('/api/matchmaking', setupMatchmakingRoutes(dbRead, matchmaking));
  app.use('/api/wallet', setupWalletRoutes(db));

  // Metrics endpoint for Prometheus
  app.get('/metrics', async (req, res) => {
    const connectedSockets = io.engine.clientsCount;
    const activeChases = (await db.query(
      `SELECT COUNT(*) as c FROM chases WHERE status IN ('heat','cooldown')`
    )).rows[0].c;
    const dbPoolInfo = {
      total: db.totalCount,
      idle: db.idleCount,
      waiting: db.waitingCount,
    };

    res.set('Content-Type', 'text/plain');
    res.send([
      `# HELP pursuitzone_connected_sockets Total WebSocket connections`,
      `# TYPE pursuitzone_connected_sockets gauge`,
      `pursuitzone_connected_sockets ${connectedSockets}`,
      `# HELP pursuitzone_active_chases Active chase sessions`,
      `# TYPE pursuitzone_active_chases gauge`,
      `pursuitzone_active_chases ${activeChases}`,
      `# HELP pursuitzone_db_pool_total Total DB connections`,
      `# TYPE pursuitzone_db_pool_total gauge`,
      `pursuitzone_db_pool_total ${dbPoolInfo.total}`,
      `pursuitzone_db_pool_idle ${dbPoolInfo.idle}`,
      `pursuitzone_db_pool_waiting ${dbPoolInfo.waiting}`,
    ].join('\n'));
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', role: ROLE, pid: process.pid }));

  // ── Background Jobs ───────────────────────────
  // Only run on 'worker' role OR if single-process mode
  if (ROLE === 'worker' || ROLE === 'api') {
    // Matchmaking broadcaster
    setInterval(() => matchmaking.expandBroadcastRadius().catch(e => logger.error(e, 'matchmaking')), 30_000);
    // Zone shrinker
    setInterval(() => chaseEngine.processZoneShrinks().catch(e => logger.error(e, 'zone-shrink')), 5_000);
    // Chase timeout
    setInterval(() => chaseEngine.processExpiredChases().catch(e => logger.error(e, 'chase-timeout')), 3_000);
    // Geofence checker
    setInterval(() => geofence.checkAllActiveChases().catch(e => logger.error(e, 'geofence')), 2_000);
    // GPS batch flush (write buffered GPS points to DB)
    setInterval(() => gpsProcessor.flushBuffer().catch(e => logger.error(e, 'gps-flush')), 1_000);
  }

  // ── Graceful Shutdown ─────────────────────────
  createTerminus(server, {
    signals: ['SIGTERM', 'SIGINT'],
    timeout: 30000,
    healthChecks: {
      '/healthz': async () => {
        await db.query('SELECT 1');
        await redis.ping();
      },
    },
    onSignal: async () => {
      logger.info('Shutting down gracefully...');
      io.close();
      await pubClient.quit();
      await subClient.quit();
      await redis.quit();
      await db.end();
      if (dbRead !== db) await dbRead.end();
    },
    onShutdown: () => logger.info('Shutdown complete'),
    logger: (msg, err) => err ? logger.error(err, msg) : logger.info(msg),
  });

  // ── Start ─────────────────────────────────────
  server.listen(PORT, () => {
    logger.info({
      port: PORT,
      role: ROLE,
      pid: process.pid,
      workers: WORKER_COUNT,
      dbPool: db.totalCount,
    }, '🏎️ PURSUIT ZONE server started');
  });
}
