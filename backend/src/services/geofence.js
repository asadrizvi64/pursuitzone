// ═══════════════════════════════════════════════════════════════
// GEOFENCE SERVICE
// Shrinking zone enforcement, boundary detection, violation handling
// ═══════════════════════════════════════════════════════════════

export class GeofenceService {
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;

    // Warning thresholds (percentage of zone radius from edge)
    this.WARNING_THRESHOLD = 0.85; // Warn at 85% of radius
    this.VIOLATION_THRESHOLD = 1.0; // Violate at 100%
    this.GRACE_PERIOD_SEC = 5;     // 5s grace to return before penalty
  }

  /**
   * Check all active chases for geofence violations.
   * Called every 2 seconds by background job.
   */
  async checkAllActiveChases() {
    const { rows: chases } = await this.db.query(
      `SELECT id, zone_center_lat, zone_center_lng, current_radius_km, wanted_user_id
       FROM chases WHERE status IN ('heat', 'cooldown')`
    );

    for (const chase of chases) {
      await this.checkChaseGeofence(chase);
    }
  }

  /**
   * Check geofence for all participants in a single chase.
   */
  async checkChaseGeofence(chase) {
    const radiusM = chase.current_radius_km * 1000;

    // Check wanted vehicle
    await this.checkUserGeofence(chase, chase.wanted_user_id, 'wanted', radiusM);

    // Check all active police
    const { rows: police } = await this.db.query(
      `SELECT user_id FROM chase_participants WHERE chase_id = $1 AND status = 'active'`,
      [chase.id]
    );
    for (const p of police) {
      await this.checkUserGeofence(chase, p.user_id, 'police', radiusM);
    }
  }

  /**
   * Check if a single user is within the geofence.
   */
  async checkUserGeofence(chase, userId, role, radiusM) {
    // Get latest GPS position
    const { rows: [pos] } = await this.db.query(
      `SELECT lat, lng, altitude FROM gps_tracks 
       WHERE chase_id = $1 AND user_id = $2 
       ORDER BY recorded_at DESC LIMIT 1`,
      [chase.id, userId]
    );

    if (!pos) return; // No GPS data yet

    // Calculate distance from zone center
    const { rows: [dist] } = await this.db.query(
      `SELECT haversine_distance($1, $2, $3, $4) as distance_m`,
      [chase.zone_center_lat, chase.zone_center_lng, pos.lat, pos.lng]
    );

    const distanceM = dist.distance_m;
    const ratio = distanceM / radiusM;

    // ── WARNING ZONE (85-100% of radius) ──
    if (ratio >= this.WARNING_THRESHOLD && ratio < this.VIOLATION_THRESHOLD) {
      const warningKey = `geofence_warning:${chase.id}:${userId}`;
      const alreadyWarned = await this.redis.get(warningKey);
      
      if (!alreadyWarned) {
        await this.redis.setex(warningKey, 30, '1'); // Don't spam, warn once per 30s
        
        // Emit real-time warning via socket
        if (this.io) {
          this.io.to(`user:${userId}`).emit('geofence_warning', {
            chaseId: chase.id,
            distanceFromEdge: Math.round(radiusM - distanceM),
            percentFromEdge: Math.round((1 - ratio) * 100),
            message: role === 'wanted' 
              ? '⚠️ ZONE BOUNDARY APPROACHING — Turn back or your bounty is voided!'
              : '⚠️ Approaching zone boundary — you will be disqualified if you leave.',
          });
        }
      }
    }

    // ── VIOLATION (>100% of radius) ──
    if (ratio > this.VIOLATION_THRESHOLD) {
      const graceKey = `geofence_grace:${chase.id}:${userId}`;
      const graceStart = await this.redis.get(graceKey);

      if (!graceStart) {
        // Start grace period
        await this.redis.setex(graceKey, this.GRACE_PERIOD_SEC + 5, Date.now().toString());
        return;
      }

      const graceElapsed = (Date.now() - parseInt(graceStart)) / 1000;
      if (graceElapsed < this.GRACE_PERIOD_SEC) return; // Still in grace period

      // ── PENALTY ──
      await this.handleViolation(chase, userId, role, distanceM, radiusM);
      await this.redis.del(graceKey);
    } else {
      // Clear grace period if they came back in
      await this.redis.del(`geofence_grace:${chase.id}:${userId}`);
    }
  }

  /**
   * Handle a confirmed geofence violation.
   */
  async handleViolation(chase, userId, role, distanceM, radiusM) {
    const overshootM = distanceM - radiusM;

    // Log violation
    await this.db.query(
      `INSERT INTO geofence_violations 
       (chase_id, user_id, role, distance_from_center_m, zone_radius_at_time_m, overshoot_m,
        chase_voided, unit_disqualified, fee_forfeited)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)`,
      [chase.id, userId, role, distanceM, radiusM, overshootM,
       role === 'wanted', role === 'police']
    );

    if (role === 'wanted') {
      // ── WANTED LEFT ZONE → ENTIRE CHASE VOIDED ──
      await this.db.query(
        `UPDATE chases SET status = 'voided_geofence', chase_ended_at = NOW(),
         end_reason = 'Wanted vehicle left the geofence zone' WHERE id = $1`,
        [chase.id]
      );

      // Wanted forfeits their fee (goes to platform + refund police)
      // Refund all police participants
      const { rows: participants } = await this.db.query(
        `SELECT user_id, fee_paid FROM chase_participants WHERE chase_id = $1 AND status = 'active'`,
        [chase.id]
      );
      for (const p of participants) {
        await this.db.query(
          `UPDATE users SET balance = balance + $2, frozen_balance = frozen_balance - $2 WHERE id = $1`,
          [p.user_id, p.fee_paid]
        );
        await this.db.query(
          `UPDATE chase_participants SET fee_refunded = TRUE, status = 'completed' WHERE chase_id = $1 AND user_id = $2`,
          [chase.id, p.user_id]
        );
      }

      // Notify everyone
      if (this.io) {
        this.io.to(`chase:${chase.id}`).emit('chase_voided', {
          reason: 'wanted_left_zone',
          message: 'Chase voided — Wanted vehicle left the zone. Police fees refunded.',
        });
      }

      console.log(`[Geofence] Chase ${chase.id.slice(0,8)}: VOIDED — wanted left zone by ${Math.round(overshootM)}m`);

    } else {
      // ── POLICE LEFT ZONE → ONLY THAT UNIT DISQUALIFIED ──
      await this.db.query(
        `UPDATE chase_participants SET status = 'disqualified', left_at = NOW(),
         disqualify_reason = 'Left geofence zone' WHERE chase_id = $1 AND user_id = $2`,
        [chase.id, userId]
      );

      // Fee forfeited (not refunded)
      await this.db.query(
        `UPDATE users SET frozen_balance = frozen_balance - (
          SELECT fee_paid FROM chase_participants WHERE chase_id = $1 AND user_id = $2
        ) WHERE id = $2`,
        [chase.id, userId]
      );

      // Update police count
      await this.db.query(
        `UPDATE chases SET current_police_count = current_police_count - 1 WHERE id = $1`,
        [chase.id]
      );

      if (this.io) {
        this.io.to(`user:${userId}`).emit('disqualified', {
          chaseId: chase.id,
          reason: 'Left geofence zone. Your fee has been forfeited.',
        });
        this.io.to(`chase:${chase.id}`).emit('police_disqualified', {
          userId,
          remainingPolice: (await this.db.query('SELECT current_police_count FROM chases WHERE id = $1', [chase.id])).rows[0]?.current_police_count,
        });
      }

      console.log(`[Geofence] Chase ${chase.id.slice(0,8)}: Police ${userId.slice(0,8)} disqualified — left zone by ${Math.round(overshootM)}m`);
    }
  }

  /**
   * Process zone shrinks for all active chases.
   */
  async processShrinks() {
    const { rows: chases } = await this.db.query(
      `SELECT id, shrink_phases, current_shrink_phase, start_radius_km, min_radius_km,
              heat_duration_sec, phase_started_at, zone_center_lat, zone_center_lng
       FROM chases WHERE status = 'heat' AND next_shrink_at IS NOT NULL AND next_shrink_at <= NOW()`
    );

    for (const chase of chases) {
      const nextPhase = chase.current_shrink_phase + 1;
      if (nextPhase >= chase.shrink_phases) continue;

      const step = (chase.start_radius_km - chase.min_radius_km) / (chase.shrink_phases - 1);
      const newRadius = chase.start_radius_km - (step * nextPhase);
      const phaseIntervalSec = chase.heat_duration_sec / chase.shrink_phases;

      // Update chase
      await this.db.query(
        `UPDATE chases SET current_radius_km = $2, current_shrink_phase = $3,
         next_shrink_at = NOW() + INTERVAL '1 second' * $4 WHERE id = $1`,
        [chase.id, newRadius, nextPhase, phaseIntervalSec]
      );

      // Log event
      const previousRadius = chase.start_radius_km - (step * chase.current_shrink_phase);
      await this.db.query(
        `INSERT INTO zone_shrink_events (chase_id, phase_number, previous_radius_km, new_radius_km)
         VALUES ($1, $2, $3, $4)`,
        [chase.id, nextPhase, previousRadius, newRadius]
      );

      // Notify all participants
      if (this.io) {
        this.io.to(`chase:${chase.id}`).emit('zone_shrink', {
          phase: nextPhase,
          totalPhases: chase.shrink_phases,
          newRadiusKm: newRadius,
          previousRadiusKm: previousRadius,
          nextShrinkInSec: phaseIntervalSec,
        });
      }

      console.log(`[Geofence] Chase ${chase.id.slice(0,8)}: Zone shrunk to ${newRadius.toFixed(1)}km (phase ${nextPhase}/${chase.shrink_phases})`);
    }
  }

  setIO(io) { this.io = io; }
}
