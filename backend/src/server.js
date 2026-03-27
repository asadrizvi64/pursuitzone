// ═══════════════════════════════════════════════════════════════
// PURSUIT ZONE — Main Server
// Express + Socket.io + PostgreSQL + PostGIS + Redis
// ═══════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import Redis from 'ioredis';
import admin from 'firebase-admin';

import { setupChaseRoutes, setupUserRoutes, setupNotificationRoutes, setupMatchmakingRoutes } from './routes/chase.js';
import { setupAuthRoutes } from './routes/auth.js';
import { setupWalletRoutes } from './routes/wallet.js';
import { MatchmakingService } from './services/matchmaking.js';
import { NotificationService } from './services/notification.js';
import { GeofenceService } from './services/geofence.js';
import { AntiCollusionService } from './services/antiCollusion.js';
import { EconomyService } from './services/economy.js';
import { ChaseEngine } from './services/chaseEngine.js';
import { setupSocketHandlers } from './sockets/chaseSocket.js';
import { authMiddleware } from './middleware/auth.js';

// ── Config ──────────────────────────────────────────
const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DEV_MODE = process.env.NODE_ENV !== 'production';

// ── Database ────────────────────────────────────────
const db = new Pool({ connectionString: DATABASE_URL, max: 20 });

// ── Redis (optional in dev) ─────────────────────────
let redis;
try {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, retryStrategy: (times) => DEV_MODE && times > 2 ? null : Math.min(times * 200, 2000) });
  redis.on('error', (err) => DEV_MODE && console.warn('[Redis] Connection failed (non-fatal in dev):', err.message));
} catch (e) {
  console.warn('[Redis] Not available — using in-memory fallback');
  redis = null;
}

// ── Firebase (Push Notifications — optional in dev) ──
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  } else {
    console.warn('[Firebase] No service account configured — push notifications disabled');
  }
} catch (e) {
  console.warn('[Firebase] Init failed (non-fatal in dev):', e.message);
}

// ── Express App ─────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// ── Services ────────────────────────────────────────
const economy = new EconomyService(db);
const notification = new NotificationService(db, redis, admin);
const geofence = new GeofenceService(db, redis);
const antiCollusion = new AntiCollusionService(db);
const matchmaking = new MatchmakingService(db, redis, notification);
const chaseEngine = new ChaseEngine(db, redis, economy, notification, geofence, antiCollusion, matchmaking);

// ── Socket.io ───────────────────────────────────────
const io = new SocketIO(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

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

setupSocketHandlers(io, chaseEngine, geofence, antiCollusion, notification);

// ── REST Routes ─────────────────────────────────────
app.locals.db = db; // For auth middleware
app.use('/api/auth', setupAuthRoutes(db));
app.use('/api/users', setupUserRoutes(db, economy));
app.use('/api/chases', setupChaseRoutes(db, chaseEngine, economy));
app.use('/api/wallet', setupWalletRoutes(db));
app.use('/api/notifications', setupNotificationRoutes(db, notification));
app.use('/api/matchmaking', setupMatchmakingRoutes(db, matchmaking));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Database connectivity check ─────────────────────
let dbConnected = false;
let dbCheckLogged = false;

async function checkDbConnection() {
  try {
    await db.query('SELECT 1');
    if (!dbConnected) {
      dbConnected = true;
      console.log('[Database] Connected successfully');
    }
    return true;
  } catch (err) {
    if (!dbCheckLogged) {
      dbCheckLogged = true;
      console.warn(`[Database] Not available — background jobs paused. Set DATABASE_URL to a valid PostgreSQL connection.`);
      console.warn(`   Tip: Get a free DB at https://supabase.com (see FREE_DEPLOY.md)`);
    }
    dbConnected = false;
    return false;
  }
}

// ── Background Jobs (only run when DB is connected) ──

// Matchmaking broadcaster — expands notification radius over time
setInterval(async () => {
  if (!dbConnected) return;
  try {
    await matchmaking.expandBroadcastRadius();
  } catch (err) {
    if (err.code !== 'ECONNREFUSED') console.error('[Matchmaking Broadcaster]', err.message);
  }
}, 30_000); // Every 30 seconds

// Zone shrinker — checks if zones need to shrink
setInterval(async () => {
  if (!dbConnected) return;
  try {
    await chaseEngine.processZoneShrinks();
  } catch (err) {
    if (err.code !== 'ECONNREFUSED') console.error('[Zone Shrinker]', err.message);
  }
}, 5_000); // Every 5 seconds

// Chase timeout checker — ends expired chases
setInterval(async () => {
  if (!dbConnected) return;
  try {
    await chaseEngine.processExpiredChases();
  } catch (err) {
    if (err.code !== 'ECONNREFUSED') console.error('[Chase Timeout]', err.message);
  }
}, 3_000); // Every 3 seconds

// Geofence violation checker — runs on all active chases
setInterval(async () => {
  if (!dbConnected) return;
  try {
    await geofence.checkAllActiveChases();
  } catch (err) {
    if (err.code !== 'ECONNREFUSED') console.error('[Geofence Checker]', err.message);
  }
}, 2_000); // Every 2 seconds

// Periodically retry DB connection
setInterval(() => checkDbConnection(), 15_000);

// ── Start ───────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🏎️  PURSUIT ZONE server running on port ${PORT}`);
  console.log(`   Socket.io: ready`);
  console.log(`   Health check: http://localhost:${PORT}/health`);

  // Check DB on startup
  await checkDbConnection();

  if (dbConnected) {
    console.log(`   Background jobs: active\n`);
  } else {
    console.log(`   Background jobs: paused (waiting for DB)\n`);
  }
});

export { app, server, io, db, redis };
