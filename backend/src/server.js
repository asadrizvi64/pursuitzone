// ═══════════════════════════════════════════════════════════════
// PURSUIT ZONE — Main Server
// Express + Socket.io + PostgreSQL + PostGIS + Redis
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import http from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import Redis from 'ioredis';
import admin from 'firebase-admin';

import { setupChaseRoutes } from './routes/chase.js';
import { setupUserRoutes } from './routes/user.js';
import { setupNotificationRoutes } from './routes/notification.js';
import { setupMatchmakingRoutes } from './routes/matchmaking.js';
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

// ── Database ────────────────────────────────────────
const db = new Pool({ connectionString: DATABASE_URL, max: 20 });
let redis;
try {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3, retryStrategy: (times) => times > 3 ? null : Math.min(times * 200, 2000) });
  redis.on('error', (err) => console.warn('[Redis] Connection error:', err.message));
} catch (err) {
  console.warn('[Redis] Failed to connect:', err.message);
  redis = null;
}

// ── Firebase (Push Notifications) ───────────────────
let firebaseEnabled = false;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
    firebaseEnabled = true;
  } catch (err) {
    console.warn('[Firebase] Failed to initialize:', err.message);
  }
} else {
  console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
}

// ── Express App ─────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60 * 1000, max: 120 }));

// ── Services ────────────────────────────────────────
const economy = new EconomyService(db);
const notification = new NotificationService(db, redis, firebaseEnabled ? admin : null);
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
app.use('/api/users', setupUserRoutes(db, economy));
app.use('/api/chases', setupChaseRoutes(db, chaseEngine, economy));
app.use('/api/notifications', setupNotificationRoutes(db, notification));
app.use('/api/matchmaking', setupMatchmakingRoutes(db, matchmaking));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ── Background Jobs ─────────────────────────────────

// Matchmaking broadcaster — expands notification radius over time
setInterval(async () => {
  try {
    await matchmaking.expandBroadcastRadius();
  } catch (err) {
    console.error('[Matchmaking Broadcaster]', err);
  }
}, 30_000); // Every 30 seconds

// Zone shrinker — checks if zones need to shrink
setInterval(async () => {
  try {
    await chaseEngine.processZoneShrinks();
  } catch (err) {
    console.error('[Zone Shrinker]', err);
  }
}, 5_000); // Every 5 seconds

// Chase timeout checker — ends expired chases
setInterval(async () => {
  try {
    await chaseEngine.processExpiredChases();
  } catch (err) {
    console.error('[Chase Timeout]', err);
  }
}, 3_000); // Every 3 seconds

// Geofence violation checker — runs on all active chases
setInterval(async () => {
  try {
    await geofence.checkAllActiveChases();
  } catch (err) {
    console.error('[Geofence Checker]', err);
  }
}, 2_000); // Every 2 seconds

// ── Start ───────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🏎️  PURSUIT ZONE server running on port ${PORT}`);
  console.log(`   Database: connected`);
  console.log(`   Redis: connected`);
  console.log(`   Socket.io: ready`);
  console.log(`   Matchmaking broadcaster: active (30s interval)`);
  console.log(`   Zone shrinker: active (5s interval)`);
  console.log(`   Geofence checker: active (2s interval)\n`);
});

export { app, server, io, db, redis };
