// ═══════════════════════════════════════════════════════════════
// CHASE ROUTES — REST API for chase lifecycle
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';

export function setupChaseRoutes(db, chaseEngine, economy) {
  const router = Router();
  router.use(authMiddleware.protect);

  // GET /api/chases/active — List active chases (for police browsing)
  router.get('/active', async (req, res) => {
    try {
      const { lat, lng, radiusKm = 50 } = req.query;
      let query = `SELECT * FROM v_active_chases WHERE status IN ('matchmaking','countdown','heat','cooldown')`;
      const params = [];

      if (lat && lng) {
        params.push(parseFloat(lat), parseFloat(lng), parseFloat(radiusKm) * 1000);
        query += ` AND haversine_distance(zone_center_lat, zone_center_lng, $1, $2) <= $3`;
        query += ` ORDER BY haversine_distance(zone_center_lat, zone_center_lng, $1, $2)`;
      } else {
        query += ` ORDER BY created_at DESC`;
      }
      query += ` LIMIT 50`;

      const { rows } = await db.query(query, params);
      
      // Enrich with economy data
      const enriched = rows.map(chase => ({
        ...chase,
        economy: economy.calculatePool(chase.wanted_fee, chase.police_ticket, chase.current_police_count),
      }));

      res.json({ chases: enriched });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/chases — Create a new chase (wanted role)
  router.post('/', async (req, res) => {
    try {
      const { wantedLevel, zoneId } = req.body;
      const chase = await chaseEngine.createChase(req.user.id, wantedLevel, zoneId);
      res.status(201).json({ chase });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // POST /api/chases/:id/join — Join a chase as police
  router.post('/:id/join', async (req, res) => {
    try {
      const result = await chaseEngine.matchmaking.joinChase(req.params.id, req.user.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // GET /api/chases/:id — Get chase details
  router.get('/:id', async (req, res) => {
    try {
      const chase = await chaseEngine.getChase(req.params.id);
      if (!chase) return res.status(404).json({ error: 'Chase not found' });
      
      const econ = economy.calculatePool(chase.wanted_fee, chase.police_ticket, chase.current_police_count);
      const { rows: participants } = await db.query(
        `SELECT cp.*, u.display_name FROM chase_participants cp
         JOIN users u ON cp.user_id = u.id WHERE cp.chase_id = $1`,
        [req.params.id]
      );

      res.json({ chase, economy: econ, participants });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chases/zones — List available chase zones
  router.get('/zones/list', async (req, res) => {
    try {
      const { rows } = await db.query('SELECT * FROM chase_zones WHERE is_active = TRUE ORDER BY city_name');
      res.json({ zones: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/chases/:id/economy — Get live prize pool breakdown
  router.get('/:id/economy', async (req, res) => {
    try {
      const chase = await chaseEngine.getChase(req.params.id);
      if (!chase) return res.status(404).json({ error: 'Chase not found' });
      res.json(economy.calculatePool(chase.wanted_fee, chase.police_ticket, chase.current_police_count));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

export function setupUserRoutes(db, economy) {
  const router = Router();
  router.use(authMiddleware.protect);

  // GET /api/users/me
  router.get('/me', async (req, res) => {
    const { rows: [user] } = await db.query(
      `SELECT id, display_name, phone, email, avatar_url,
       wanted_rating, wanted_escapes, wanted_busts, wanted_earnings,
       police_rating, police_captures, police_misses, police_earnings,
       balance, frozen_balance, preferred_role, trust_score
       FROM users WHERE id = $1`, [req.user.id]
    );
    res.json({ user });
  });

  // GET /api/users/me/transactions
  router.get('/me/transactions', async (req, res) => {
    const { rows } = await db.query(
      `SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ transactions: rows });
  });

  // PUT /api/users/me/location
  router.put('/me/location', async (req, res) => {
    const { lat, lng, altitude } = req.body;
    await db.query(
      `UPDATE users SET last_known_lat = $2, last_known_lng = $3, last_known_alt = $4,
       last_location_at = NOW()
       WHERE id = $1`,
      [req.user.id, lat, lng, altitude]
    );
    res.json({ ok: true });
  });

  // PUT /api/users/me/fcm-token
  router.put('/me/fcm-token', async (req, res) => {
    await db.query('UPDATE users SET fcm_token = $2 WHERE id = $1', [req.user.id, req.body.token]);
    res.json({ ok: true });
  });

  return router;
}

export function setupNotificationRoutes(db, notification) {
  const router = Router();
  router.use(authMiddleware.protect);

  router.get('/unread', async (req, res) => {
    const notifications = await notification.getUnread(req.user.id);
    res.json({ notifications });
  });

  router.post('/:id/read', async (req, res) => {
    await notification.markRead(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  router.post('/:id/acted', async (req, res) => {
    await notification.markActedOn(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  return router;
}

export function setupMatchmakingRoutes(db, matchmaking) {
  const router = Router();
  router.use(authMiddleware.protect);

  // GET /api/matchmaking/nearby — Chases that need police near user
  router.get('/nearby', async (req, res) => {
    const { lat, lng } = req.query;
    const { rows } = await db.query(
      `SELECT c.*, z.city_name, z.zone_name, u.display_name as wanted_name
       FROM chases c
       JOIN chase_zones z ON c.zone_id = z.id
       JOIN users u ON c.wanted_user_id = u.id
       WHERE c.status = 'matchmaking'
       AND haversine_distance(c.zone_center_lat, c.zone_center_lng, $1, $2) <= c.matchmaking_broadcast_radius_km * 1000
       ORDER BY c.wanted_level DESC, c.created_at ASC`,
      [parseFloat(lat), parseFloat(lng)]
    );
    res.json({ chases: rows });
  });

  return router;
}
