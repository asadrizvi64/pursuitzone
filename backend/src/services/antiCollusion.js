// ═══════════════════════════════════════════════════════════════
// ANTI-COLLUSION SERVICE
// Prevents staged captures, GPS spoofing, friend collusion
// ═══════════════════════════════════════════════════════════════

const THRESHOLDS = {
  MIN_START_DISTANCE_M: 2000,   // Must start 2km+ from wanted
  MIN_APPROACH_SPEED_KMH: 5,    // Must be moving >5 km/h
  SUSTAINED_PURSUIT_SEC: 120,   // Must pursue for 2+ minutes
  MIN_TRACKING_POINTS: 20,      // Need 20+ real GPS pings
  MAX_TAG_RADIUS_M: 150,        // Must be within 150m horizontally
  MAX_ALTITUDE_DIFF_M: 8,       // Must be within ±8m vertically (same floor)
  TAG_COOLDOWN_SEC: 30,         // 30s between tag attempts
  MAX_SAME_PAIR_PER_DAY: 3,     // Same wanted+police can only meet 3x/day
  MIN_GPS_ACCURACY_M: 50,       // GPS accuracy must be <50m
};

export class AntiCollusionService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Validate a tag attempt.
   * Returns { valid, checks, reason } where checks shows each criterion's status.
   */
  async validateTag(chaseId, policeUserId) {
    const chase = await this.getChase(chaseId);
    const participant = await this.getParticipant(chaseId, policeUserId);
    
    if (!chase || !participant) {
      return { valid: false, reason: 'Chase or participant not found' };
    }

    // Get latest positions for both
    const [policePos, wantedPos] = await Promise.all([
      this.getLatestPosition(chaseId, policeUserId),
      this.getLatestPosition(chaseId, chase.wanted_user_id),
    ]);

    if (!policePos || !wantedPos) {
      return { valid: false, reason: 'GPS position unavailable' };
    }

    // ── Run all checks ──
    const checks = {};

    // 1. Start distance
    checks.startDistance = {
      value: participant.start_distance_m,
      required: THRESHOLDS.MIN_START_DISTANCE_M,
      pass: participant.start_distance_m >= THRESHOLDS.MIN_START_DISTANCE_M,
    };

    // 2. Approach speed (average speed over last 30 seconds)
    const avgSpeed = await this.getAverageSpeed(chaseId, policeUserId, 30);
    checks.approachSpeed = {
      value: avgSpeed,
      required: THRESHOLDS.MIN_APPROACH_SPEED_KMH,
      pass: avgSpeed >= THRESHOLDS.MIN_APPROACH_SPEED_KMH,
    };

    // 3. Sustained pursuit time
    const pursuitTime = await this.getSustainedPursuitTime(chaseId, policeUserId);
    checks.sustainedPursuit = {
      value: pursuitTime,
      required: THRESHOLDS.SUSTAINED_PURSUIT_SEC,
      pass: pursuitTime >= THRESHOLDS.SUSTAINED_PURSUIT_SEC,
    };

    // 4. GPS tracking points (real movement)
    const trackingPoints = await this.getTrackingPointCount(chaseId, policeUserId);
    checks.gpsIntegrity = {
      value: trackingPoints,
      required: THRESHOLDS.MIN_TRACKING_POINTS,
      pass: trackingPoints >= THRESHOLDS.MIN_TRACKING_POINTS,
    };

    // 5. Horizontal distance
    const { rows: [dist3d] } = await this.db.query(
      `SELECT * FROM distance_3d($1, $2, $3, $4, $5, $6)`,
      [policePos.lat, policePos.lng, policePos.altitude,
       wantedPos.lat, wantedPos.lng, wantedPos.altitude]
    );
    
    checks.horizontalDistance = {
      value: dist3d.horizontal_m,
      required: THRESHOLDS.MAX_TAG_RADIUS_M,
      pass: dist3d.horizontal_m <= THRESHOLDS.MAX_TAG_RADIUS_M,
    };

    // 6. Vertical distance (altitude / floor matching)
    checks.altitudeMatch = {
      value: dist3d.vertical_m,
      required: THRESHOLDS.MAX_ALTITUDE_DIFF_M,
      pass: dist3d.vertical_m <= THRESHOLDS.MAX_ALTITUDE_DIFF_M,
    };

    // 7. GPS accuracy check (no spoofing)
    checks.gpsAccuracy = {
      value: policePos.accuracy,
      required: THRESHOLDS.MIN_GPS_ACCURACY_M,
      pass: policePos.accuracy <= THRESHOLDS.MIN_GPS_ACCURACY_M,
    };

    // 8. Mock location check
    checks.noMockLocation = {
      value: policePos.is_mock_location ? 'MOCK DETECTED' : 'clean',
      pass: !policePos.is_mock_location,
    };

    // 9. Same-pair frequency check (anti repeat collusion)
    const pairCount = await this.getSamePairCount(chase.wanted_user_id, policeUserId);
    checks.pairFrequency = {
      value: pairCount,
      required: THRESHOLDS.MAX_SAME_PAIR_PER_DAY,
      pass: pairCount <= THRESHOLDS.MAX_SAME_PAIR_PER_DAY,
    };

    // 10. Movement pattern analysis (are GPS points showing a real driving pattern?)
    const movementScore = await this.analyzeMovementPattern(chaseId, policeUserId);
    checks.movementPattern = {
      value: movementScore,
      required: 0.6, // 60% confidence of real movement
      pass: movementScore >= 0.6,
    };

    // ── Aggregate result ──
    const allPassed = Object.values(checks).every(c => c.pass);
    const failedChecks = Object.entries(checks).filter(([, c]) => !c.pass).map(([name]) => name);

    // Log any failures as collusion flags
    if (!allPassed) {
      for (const failedCheck of failedChecks) {
        await this.db.query(
          `INSERT INTO collusion_flags (chase_id, flagged_user_id, flag_type, details_json, severity)
           VALUES ($1, $2, $3, $4, $5)`,
          [chaseId, policeUserId, failedCheck, JSON.stringify(checks[failedCheck]),
           failedCheck === 'noMockLocation' ? 5 : failedCheck === 'startDistance' ? 3 : 2]
        );
      }
    }

    // Update participant with tag attempt data
    await this.db.query(
      `UPDATE chase_participants SET 
       tag_attempted_at = NOW(),
       tag_horizontal_dist = $3,
       tag_vertical_dist = $4,
       tag_validated = $5,
       sustained_pursuit_sec = $6,
       gps_tracking_points = $7,
       altitude_at_tag = $8
       WHERE chase_id = $1 AND user_id = $2`,
      [chaseId, policeUserId, dist3d.horizontal_m, dist3d.vertical_m,
       allPassed, pursuitTime, trackingPoints, policePos.altitude]
    );

    return {
      valid: allPassed,
      checks,
      failedChecks,
      reason: allPassed ? 'All checks passed' : `Failed: ${failedChecks.join(', ')}`,
      distances: dist3d,
    };
  }

  async getLatestPosition(chaseId, userId) {
    const { rows: [pos] } = await this.db.query(
      `SELECT lat, lng, altitude, accuracy, speed, is_mock_location
       FROM gps_tracks WHERE chase_id = $1 AND user_id = $2
       ORDER BY recorded_at DESC LIMIT 1`,
      [chaseId, userId]
    );
    return pos;
  }

  async getAverageSpeed(chaseId, userId, windowSec) {
    const { rows: [result] } = await this.db.query(
      `SELECT AVG(speed) as avg_speed FROM gps_tracks
       WHERE chase_id = $1 AND user_id = $2 
       AND recorded_at > NOW() - INTERVAL '1 second' * $3
       AND speed IS NOT NULL`,
      [chaseId, userId, windowSec]
    );
    return result?.avg_speed || 0;
  }

  async getSustainedPursuitTime(chaseId, userId) {
    const { rows: [result] } = await this.db.query(
      `SELECT EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) as pursuit_sec
       FROM gps_tracks WHERE chase_id = $1 AND user_id = $2 AND speed > 3`,
      [chaseId, userId]
    );
    return result?.pursuit_sec || 0;
  }

  async getTrackingPointCount(chaseId, userId) {
    const { rows: [result] } = await this.db.query(
      `SELECT COUNT(*) as cnt FROM gps_tracks 
       WHERE chase_id = $1 AND user_id = $2 AND speed > 1`,
      [chaseId, userId]
    );
    return parseInt(result?.cnt || 0);
  }

  async getSamePairCount(wantedUserId, policeUserId) {
    const { rows: [result] } = await this.db.query(
      `SELECT COUNT(*) as cnt FROM chase_participants cp
       JOIN chases c ON cp.chase_id = c.id
       WHERE c.wanted_user_id = $1 AND cp.user_id = $2
       AND c.created_at > NOW() - INTERVAL '24 hours'`,
      [wantedUserId, policeUserId]
    );
    return parseInt(result?.cnt || 0);
  }

  /**
   * Analyze GPS movement pattern for authenticity.
   * Returns 0-1 confidence score.
   */
  async analyzeMovementPattern(chaseId, userId) {
    const { rows: points } = await this.db.query(
      `SELECT lat, lng, speed, heading, recorded_at
       FROM gps_tracks WHERE chase_id = $1 AND user_id = $2
       ORDER BY recorded_at ASC LIMIT 50`,
      [chaseId, userId]
    );

    if (points.length < 5) return 0;

    let score = 0;
    let checks = 0;

    // Check 1: Speed variance (real driving has varied speeds)
    const speeds = points.map(p => p.speed).filter(Boolean);
    if (speeds.length > 3) {
      const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      const variance = speeds.reduce((sum, s) => sum + Math.pow(s - avgSpeed, 2), 0) / speeds.length;
      score += variance > 10 ? 1 : variance > 2 ? 0.5 : 0; // Real driving has speed variance
      checks++;
    }

    // Check 2: Heading changes (real driving turns)
    const headings = points.map(p => p.heading).filter(Boolean);
    if (headings.length > 5) {
      let turns = 0;
      for (let i = 1; i < headings.length; i++) {
        const diff = Math.abs(headings[i] - headings[i - 1]);
        if (diff > 15 && diff < 345) turns++;
      }
      score += turns > 3 ? 1 : turns > 1 ? 0.5 : 0;
      checks++;
    }

    // Check 3: Position spread (not stationary)
    const lats = points.map(p => p.lat);
    const lngs = points.map(p => p.lng);
    const latSpread = Math.max(...lats) - Math.min(...lats);
    const lngSpread = Math.max(...lngs) - Math.min(...lngs);
    score += (latSpread > 0.001 || lngSpread > 0.001) ? 1 : 0;
    checks++;

    // Check 4: Time intervals are consistent (not bulk-injected)
    const times = points.map(p => new Date(p.recorded_at).getTime());
    if (times.length > 3) {
      const intervals = [];
      for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const allSimilar = intervals.every(i => Math.abs(i - avgInterval) < avgInterval * 0.5);
      score += allSimilar ? 0.5 : 1; // Real GPS has slight timing variance
      checks++;
    }

    return checks > 0 ? score / checks : 0;
  }

  async getChase(chaseId) {
    const { rows: [chase] } = await this.db.query('SELECT * FROM chases WHERE id = $1', [chaseId]);
    return chase;
  }

  async getParticipant(chaseId, userId) {
    const { rows: [p] } = await this.db.query(
      'SELECT * FROM chase_participants WHERE chase_id = $1 AND user_id = $2', [chaseId, userId]
    );
    return p;
  }
}
