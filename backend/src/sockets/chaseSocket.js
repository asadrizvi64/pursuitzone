// ═══════════════════════════════════════════════════════════════
// SOCKET.IO HANDLERS
// Real-time GPS streaming, chase events, notifications
// ═══════════════════════════════════════════════════════════════

export function setupSocketHandlers(io, chaseEngine, geofence, antiCollusion, notification) {
  // Give services access to io for broadcasting
  geofence.setIO(io);
  notification.setIO(io);

  io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`[Socket] Connected: ${userId.slice(0, 8)}`);

    // Join personal room for notifications
    socket.join(`user:${userId}`);

    // ── GPS STREAM ──────────────────────────────────
    // Client sends GPS updates every 1-2 seconds during active chase
    socket.on('gps_update', async (data) => {
      try {
        const { chaseId, lat, lng, altitude, accuracy, speed, heading, altitudeSource, isMockLocation } = data;
        
        // Store in DB
        await chaseEngine.db.query(
          `INSERT INTO gps_tracks (chase_id, user_id, lat, lng, altitude, accuracy, speed, heading, altitude_source, is_mock_location)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [chaseId, userId, lat, lng, altitude, accuracy, speed, heading, altitudeSource, isMockLocation || false]
        );

        // Update user's last known position
        await chaseEngine.db.query(
          `UPDATE users SET last_known_lat = $2, last_known_lng = $3, last_known_alt = $4, 
           last_location_at = NOW()
           WHERE id = $1`,
          [userId, lat, lng, altitude]
        );

        // Broadcast position to other chase participants (redacted for fairness)
        // Police see wanted's general area (100m radius blur)
        // Wanted sees police positions precisely (they need to evade)
        const chase = await chaseEngine.getChase(chaseId);
        if (!chase) return;

        if (userId === chase.wanted_user_id) {
          // Blur wanted's position for police (show within 100m radius)
          const blurredLat = lat + (Math.random() - 0.5) * 0.001;
          const blurredLng = lng + (Math.random() - 0.5) * 0.001;
          socket.to(`chase:${chaseId}:police`).emit('target_position', {
            lat: blurredLat, lng: blurredLng,
            altitude: Math.round(altitude),
            timestamp: Date.now(),
            blurred: true,
          });
        } else {
          // Police position visible to wanted (precise)
          socket.to(`chase:${chaseId}:wanted`).emit('pursuit_position', {
            userId, lat, lng, altitude, speed,
            timestamp: Date.now(),
          });
          // Also share with other police (team awareness)
          socket.to(`chase:${chaseId}:police`).emit('team_position', {
            userId, lat, lng, speed,
            timestamp: Date.now(),
          });
        }

        // Store in Redis for fast access (latest position per user per chase)
        await chaseEngine.redis.hset(`chase_positions:${chaseId}`, userId, JSON.stringify({
          lat, lng, altitude, speed, accuracy, timestamp: Date.now(),
        }));

      } catch (err) {
        console.error('[Socket] GPS update error:', err);
      }
    });

    // ── JOIN CHASE ROOM ─────────────────────────────
    socket.on('join_chase', async ({ chaseId, role }) => {
      socket.join(`chase:${chaseId}`);
      socket.join(`chase:${chaseId}:${role}`);
      socket.chaseId = chaseId;
      socket.chaseRole = role;
      console.log(`[Socket] User ${userId.slice(0, 8)} joined chase ${chaseId.slice(0, 8)} as ${role}`);
    });

    // ── TAG ATTEMPT ─────────────────────────────────
    socket.on('tag_attempt', async ({ chaseId }) => {
      try {
        // Validate through anti-collusion system
        const result = await antiCollusion.validateTag(chaseId, userId);
        
        socket.emit('tag_result', result);

        if (result.valid) {
          // Tag confirmed! End the chase
          await chaseEngine.endChase(chaseId, 'caught', userId);
          
          io.to(`chase:${chaseId}`).emit('chase_ended', {
            outcome: 'caught',
            taggerId: userId,
            distances: result.distances,
          });
        } else {
          // Tag failed — show which checks failed
          socket.emit('tag_failed', {
            reason: result.reason,
            checks: result.checks,
            failedChecks: result.failedChecks,
          });
        }
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── REINFORCEMENT REQUEST ───────────────────────
    socket.on('request_reinforcement', async ({ chaseId }) => {
      try {
        await chaseEngine.requestReinforcement(chaseId, userId);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── WANTED: ESCALATE / CASH OUT ─────────────────
    socket.on('wanted_decision', async ({ chaseId, decision }) => {
      try {
        if (decision === 'cashout') {
          await chaseEngine.endChase(chaseId, 'escaped');
        } else if (decision === 'escalate') {
          await chaseEngine.escalateChase(chaseId);
        }
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── SURRENDER ───────────────────────────────────
    socket.on('surrender', async ({ chaseId }) => {
      try {
        await chaseEngine.endChase(chaseId, 'surrendered');
        io.to(`chase:${chaseId}`).emit('chase_ended', { outcome: 'surrendered' });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── LOCATION UPDATE (idle, not in chase) ────────
    socket.on('idle_location', async ({ lat, lng, altitude }) => {
      await chaseEngine.db.query(
        `UPDATE users SET last_known_lat = $2, last_known_lng = $3, last_known_alt = $4,
         last_location_at = NOW()
         WHERE id = $1`,
        [userId, lat, lng, altitude]
      );
    });

    // ── DISCONNECT ──────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${userId.slice(0, 8)}`);
    });
  });
}
