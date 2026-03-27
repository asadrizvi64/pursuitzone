// ═══════════════════════════════════════════════════════════════
// CHASE ENGINE
// Core game loop: create → matchmake → countdown → heat → cooldown → result
// ═══════════════════════════════════════════════════════════════

const WANTED_LEVELS = [
  { level: 1, heatMin: 15, cooldownMin: 5, shrinkPhases: 2, policeMin: 1, policeMax: 2, startRadiusKm: 12, minRadiusKm: 4 },
  { level: 2, heatMin: 20, cooldownMin: 8, shrinkPhases: 3, policeMin: 2, policeMax: 4, startRadiusKm: 10, minRadiusKm: 3 },
  { level: 3, heatMin: 30, cooldownMin: 12, shrinkPhases: 4, policeMin: 3, policeMax: 8, startRadiusKm: 9, minRadiusKm: 2.5 },
  { level: 4, heatMin: 45, cooldownMin: 15, shrinkPhases: 5, policeMin: 5, policeMax: 15, startRadiusKm: 8, minRadiusKm: 2 },
  { level: 5, heatMin: 60, cooldownMin: 20, shrinkPhases: 6, policeMin: 8, policeMax: 25, startRadiusKm: 8, minRadiusKm: 1.5 },
];

export class ChaseEngine {
  constructor(db, redis, economy, notification, geofence, antiCollusion, matchmaking) {
    this.db = db;
    this.redis = redis;
    this.economy = economy;
    this.notification = notification;
    this.geofence = geofence;
    this.antiCollusion = antiCollusion;
    this.matchmaking = matchmaking;
    this.io = null;
  }

  setIO(io) { this.io = io; }

  /**
   * Create a new chase (called by wanted player).
   */
  async createChase(wantedUserId, wantedLevel, zoneId) {
    const config = WANTED_LEVELS[wantedLevel - 1];
    if (!config) throw new Error('Invalid wanted level');

    const fees = this.economy.getLevelFees(wantedLevel);
    
    // Verify balance
    const { rows: [user] } = await this.db.query('SELECT balance FROM users WHERE id = $1', [wantedUserId]);
    if (user.balance < fees.wantedFee) throw new Error('Insufficient balance');

    // Get zone details
    const { rows: [zone] } = await this.db.query('SELECT * FROM chase_zones WHERE id = $1', [zoneId]);
    if (!zone) throw new Error('Invalid zone');

    // Freeze wanted fee
    await this.db.query(
      'UPDATE users SET balance = balance - $2, frozen_balance = frozen_balance + $2 WHERE id = $1',
      [wantedUserId, fees.wantedFee]
    );

    const heatSec = config.heatMin * 60;
    const cooldownSec = config.cooldownMin * 60;

    // Create chase record
    const { rows: [chase] } = await this.db.query(
      `INSERT INTO chases (
        wanted_user_id, wanted_level, zone_id,
        start_radius_km, current_radius_km, min_radius_km, shrink_phases,
        zone_center_lat, zone_center_lng,
        heat_duration_sec, cooldown_duration_sec,
        wanted_fee, police_ticket, total_pool, platform_fee, reward_pool,
        min_police_required, max_police,
        status
      ) VALUES (
        $1, $2, $3, $4, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $11, $13, $14, $15, 'matchmaking'
      ) RETURNING *`,
      [
        wantedUserId, wantedLevel, zoneId,
        config.startRadiusKm, config.minRadiusKm, config.shrinkPhases,
        zone.center_lat, zone.center_lng,
        heatSec, cooldownSec,
        fees.wantedFee, fees.policeTicket,
        Math.round(fees.wantedFee * 0.15),   // initial platform fee
        fees.wantedFee - Math.round(fees.wantedFee * 0.15), // initial pool
        config.policeMin, config.policeMax,
      ]
    );

    // Record transaction
    await this.db.query(
      `INSERT INTO transactions (user_id, chase_id, type, amount, balance_after, description)
       VALUES ($1, $2, 'chase_fee_wanted', $3, (SELECT balance FROM users WHERE id = $1), $4)`,
      [wantedUserId, chase.id, -fees.wantedFee, `Participation fee for ${wantedLevel}★ chase`]
    );

    // Start matchmaking (broadcasts to nearby users)
    await this.matchmaking.startMatchmaking(chase.id);

    console.log(`[Chase] Created ${chase.id.slice(0,8)}: ${wantedLevel}★ in ${zone.city_name} by ${wantedUserId.slice(0,8)}`);
    return chase;
  }

  /**
   * Start the actual chase (called after countdown).
   */
  async startHeatPhase(chaseId) {
    const chase = await this.getChase(chaseId);
    const config = WANTED_LEVELS[chase.wanted_level - 1];
    const phaseInterval = (config.heatMin * 60) / config.shrinkPhases;

    await this.db.query(
      `UPDATE chases SET status = 'heat', phase_started_at = NOW(), chase_started_at = NOW(),
       next_shrink_at = NOW() + INTERVAL '1 second' * $2
       WHERE id = $1`,
      [chaseId, phaseInterval]
    );

    // Activate all queued participants
    await this.db.query(
      `UPDATE chase_participants SET status = 'active' WHERE chase_id = $1 AND status = 'queued'`,
      [chaseId]
    );

    if (this.io) {
      this.io.to(`chase:${chaseId}`).emit('chase_started', {
        heatDurationSec: config.heatMin * 60,
        startRadiusKm: config.startRadiusKm,
        shrinkPhases: config.shrinkPhases,
        firstShrinkInSec: phaseInterval,
      });
    }

    console.log(`[Chase] ${chaseId.slice(0,8)}: HEAT PHASE started`);
  }

  /**
   * Process zone shrinks for all active chases. Called by interval.
   */
  async processZoneShrinks() {
    await this.geofence.processShrinks();
  }

  /**
   * Process expired chases (heat → cooldown, cooldown → ended).
   */
  async processExpiredChases() {
    // Countdown → heat (after 60s)
    const { rows: countdowns } = await this.db.query(
      `SELECT id FROM chases WHERE status = 'countdown' 
       AND phase_started_at + INTERVAL '60 seconds' <= NOW()`
    );
    for (const c of countdowns) {
      await this.startHeatPhase(c.id);
    }

    // Heat → cooldown
    const { rows: heats } = await this.db.query(
      `SELECT id, cooldown_duration_sec FROM chases WHERE status = 'heat'
       AND phase_started_at + INTERVAL '1 second' * heat_duration_sec <= NOW()`
    );
    for (const c of heats) {
      await this.db.query(
        `UPDATE chases SET status = 'cooldown', phase_started_at = NOW() WHERE id = $1`,
        [c.id]
      );
      if (this.io) {
        this.io.to(`chase:${c.id}`).emit('phase_change', {
          phase: 'cooldown',
          durationSec: c.cooldown_duration_sec,
        });
      }
    }

    // Cooldown → ended (wanted escaped!)
    const { rows: cooldowns } = await this.db.query(
      `SELECT id FROM chases WHERE status = 'cooldown'
       AND phase_started_at + INTERVAL '1 second' * cooldown_duration_sec <= NOW()`
    );
    for (const c of cooldowns) {
      // Don't auto-end — let wanted choose: cash out or escalate
      // Send notification to wanted
      const chase = await this.getChase(c.id);
      await this.notification.send({
        userId: chase.wanted_user_id,
        chaseId: c.id,
        type: 'chase_ended',
        title: '🏁 CHASE SURVIVED!',
        body: 'Cash out your reward or increase the heat for a bigger pool.',
        data: { action: 'choose_outcome' },
      });

      if (this.io) {
        this.io.to(`chase:${c.id}`).emit('cooldown_expired', {
          message: 'Waiting for wanted vehicle decision...',
        });
      }

      // Auto cash-out after 60s if no decision
      await this.redis.setex(`auto_cashout:${c.id}`, 60, '1');
    }

    // Auto cash-out check
    const keys = await this.redis.keys('auto_cashout:*');
    for (const key of keys) {
      const ttl = await this.redis.ttl(key);
      if (ttl <= 0) {
        const chaseId = key.split(':')[1];
        const chase = await this.getChase(chaseId);
        if (chase && chase.status === 'cooldown') {
          await this.endChase(chaseId, 'escaped');
        }
        await this.redis.del(key);
      }
    }
  }

  /**
   * End a chase with a specific outcome.
   */
  async endChase(chaseId, outcome, taggerUserId = null) {
    const statusMap = {
      caught: 'caught',
      escaped: 'escaped',
      surrendered: 'surrendered',
      voided: 'voided_geofence',
    };

    await this.db.query(
      `UPDATE chases SET status = $2, chase_ended_at = NOW(), end_reason = $3 WHERE id = $1`,
      [chaseId, statusMap[outcome] || outcome, outcome]
    );

    if (taggerUserId) {
      await this.db.query(
        `UPDATE chase_participants SET status = 'tagged_target' WHERE chase_id = $1 AND user_id = $2`,
        [chaseId, taggerUserId]
      );
    }

    // Distribute rewards
    const poolResult = await this.economy.distributeRewards(chaseId, outcome);

    // Notify everyone
    const chase = await this.getChase(chaseId);
    if (this.io) {
      this.io.to(`chase:${chaseId}`).emit('chase_ended', {
        outcome, taggerUserId, pool: poolResult,
      });
    }

    // Clean up Redis
    await this.redis.del(`chase_positions:${chaseId}`);
    await this.redis.del(`auto_cashout:${chaseId}`);

    console.log(`[Chase] ${chaseId.slice(0,8)}: ENDED — ${outcome}`);
    return poolResult;
  }

  /**
   * Escalate chase to higher wanted level.
   */
  async escalateChase(chaseId) {
    const chase = await this.getChase(chaseId);
    if (chase.wanted_level >= 5) throw new Error('Already at maximum wanted level');
    
    const newLevel = chase.wanted_level + 1;
    const newConfig = WANTED_LEVELS[newLevel - 1];
    const newFees = this.economy.getLevelFees(newLevel);

    // Charge additional fee
    const additionalFee = newFees.wantedFee - chase.wanted_fee;
    const { rows: [user] } = await this.db.query('SELECT balance FROM users WHERE id = $1', [chase.wanted_user_id]);
    if (user.balance < additionalFee) throw new Error('Insufficient balance for escalation');

    await this.db.query(
      'UPDATE users SET balance = balance - $2, frozen_balance = frozen_balance + $2 WHERE id = $1',
      [chase.wanted_user_id, additionalFee]
    );

    // Update chase
    await this.db.query(
      `UPDATE chases SET wanted_level = $2, max_police = $3, 
       heat_duration_sec = $4, cooldown_duration_sec = $5,
       wanted_fee = wanted_fee + $6, total_pool = total_pool + $6,
       status = 'heat', phase_started_at = NOW(),
       shrink_phases = $7, min_radius_km = $8
       WHERE id = $1`,
      [chaseId, newLevel, newConfig.policeMax, newConfig.heatMin * 60, newConfig.cooldownMin * 60,
       additionalFee, newConfig.shrinkPhases, newConfig.minRadiusKm]
    );

    // Open more police slots — trigger matchmaking for new slots
    await this.matchmaking.startMatchmaking(chaseId);

    if (this.io) {
      this.io.to(`chase:${chaseId}`).emit('chase_escalated', {
        newLevel, newMaxPolice: newConfig.policeMax,
        newHeatDuration: newConfig.heatMin * 60,
      });
    }

    console.log(`[Chase] ${chaseId.slice(0,8)}: ESCALATED to ${newLevel}★`);
  }

  /**
   * Police requests reinforcement (re-broadcasts to wider area).
   */
  async requestReinforcement(chaseId, requesterId) {
    const chase = await this.getChase(chaseId);
    if (chase.current_police_count >= chase.max_police) {
      throw new Error('Chase already at maximum police capacity');
    }
    // Trigger a new matchmaking broadcast at expanded radius
    await this.matchmaking.broadcastChase(chaseId, {
      radiusKm: 30, urgency: 'urgent',
    });
  }

  async getChase(chaseId) {
    const { rows: [chase] } = await this.db.query('SELECT * FROM chases WHERE id = $1', [chaseId]);
    return chase;
  }
}
