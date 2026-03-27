// ═══════════════════════════════════════════════════════════════
// MATCHMAKING SERVICE
// Handles finding police for chases with expanding radius broadcasts
// ═══════════════════════════════════════════════════════════════

/*
  BROADCAST ESCALATION STRATEGY:
  When a wanted vehicle creates a chase, we need police to join.
  Instead of spamming everyone in the city, we expand gradually:
  
  T+0s:    5km radius  — nearby users, high chance of quick start
  T+30s:   10km radius — wider net
  T+90s:   20km radius — getting serious
  T+180s:  40km radius — urgent, city-wide
  T+300s:  80km radius — final broadcast
  T+600s:  Cancel chase, refund wanted fee if min police not met
  
  Each broadcast only notifies NEW users (not already notified).
  Notification urgency increases with each escalation.
*/

const BROADCAST_SCHEDULE = [
  { delaySec: 0,   radiusKm: 5,  urgency: 'normal' },
  { delaySec: 30,  radiusKm: 10, urgency: 'normal' },
  { delaySec: 90,  radiusKm: 20, urgency: 'high' },
  { delaySec: 180, radiusKm: 40, urgency: 'urgent' },
  { delaySec: 300, radiusKm: 80, urgency: 'critical' },
];
const CANCEL_AFTER_SEC = 600; // 10 minutes

export class MatchmakingService {
  constructor(db, redis, notification) {
    this.db = db;
    this.redis = redis;
    this.notification = notification;
  }

  /**
   * Start matchmaking for a new chase.
   * Immediately broadcasts to users within initial radius.
   */
  async startMatchmaking(chaseId) {
    const chase = await this.getChase(chaseId);
    if (!chase) throw new Error('Chase not found');

    // Mark chase as matchmaking
    await this.db.query(
      `UPDATE chases SET status = 'matchmaking', matchmaking_started_at = NOW(), 
       matchmaking_broadcast_radius_km = $2 WHERE id = $1`,
      [chaseId, BROADCAST_SCHEDULE[0].radiusKm]
    );

    // Store broadcast state in Redis for fast access
    await this.redis.hset(`matchmaking:${chaseId}`, {
      escalation_index: 0,
      started_at: Date.now(),
      notified_users: JSON.stringify([chase.wanted_user_id]), // Don't notify the wanted
    });

    // First broadcast
    await this.broadcastChase(chaseId, BROADCAST_SCHEDULE[0]);
    
    return { chaseId, status: 'matchmaking', initialRadius: BROADCAST_SCHEDULE[0].radiusKm };
  }

  /**
   * Called every 30s by the background job.
   * Expands broadcast radius for all matchmaking chases.
   */
  async expandBroadcastRadius() {
    const { rows: chases } = await this.db.query(
      `SELECT id, matchmaking_started_at, zone_center_lat, zone_center_lng,
              min_police_required, current_police_count, wanted_level
       FROM chases WHERE status = 'matchmaking'`
    );

    for (const chase of chases) {
      const state = await this.redis.hgetall(`matchmaking:${chase.id}`);
      if (!state.started_at) continue;

      const elapsedSec = (Date.now() - parseInt(state.started_at)) / 1000;
      const currentIdx = parseInt(state.escalation_index || 0);

      // Check if we should cancel
      if (elapsedSec >= CANCEL_AFTER_SEC && chase.current_police_count < chase.min_police_required) {
        await this.cancelMatchmaking(chase.id, 'timeout');
        continue;
      }

      // Check if we need to escalate
      const nextIdx = currentIdx + 1;
      if (nextIdx < BROADCAST_SCHEDULE.length && elapsedSec >= BROADCAST_SCHEDULE[nextIdx].delaySec) {
        await this.redis.hset(`matchmaking:${chase.id}`, 'escalation_index', nextIdx);
        await this.broadcastChase(chase.id, BROADCAST_SCHEDULE[nextIdx]);
        
        await this.db.query(
          `UPDATE chases SET matchmaking_broadcast_radius_km = $2, matchmaking_escalation_count = $3 WHERE id = $1`,
          [chase.id, BROADCAST_SCHEDULE[nextIdx].radiusKm, nextIdx]
        );
      }

      // Check if we have enough police to start
      if (chase.current_police_count >= chase.min_police_required) {
        await this.startCountdown(chase.id);
      }
    }
  }

  /**
   * Broadcast a chase to nearby users who haven't been notified yet.
   */
  async broadcastChase(chaseId, schedule) {
    const chase = await this.getChase(chaseId);
    if (!chase) return;

    const state = await this.redis.hgetall(`matchmaking:${chaseId}`);
    const alreadyNotified = JSON.parse(state.notified_users || '[]');

    // Find nearby users using PostGIS
    const { rows: nearbyUsers } = await this.db.query(
      `SELECT * FROM find_nearby_users($1, $2, $3)`,
      [chase.zone_center_lng, chase.zone_center_lat, schedule.radiusKm * 1000]
    );

    // Filter out already-notified and the wanted user
    const newUsers = nearbyUsers.filter(u => 
      !alreadyNotified.includes(u.user_id) &&
      (u.preferred_role === 'police' || u.preferred_role === 'both')
    );

    if (newUsers.length === 0) return;

    // Build notification
    const wantedLevel = chase.wanted_level;
    const stars = '⭐'.repeat(wantedLevel);
    const titles = {
      normal: `${stars} Chase nearby — ${chase.city_name}`,
      high: `${stars} Active pursuit needs backup!`,
      urgent: `🚨 ${stars} URGENT: Chase needs police NOW`,
      critical: `🔴 ${stars} CRITICAL: Last call for pursuit!`,
    };
    const poolInfo = Math.round(chase.reward_pool / 100);

    // Send notifications
    const notifications = newUsers.map(user => ({
      userId: user.user_id,
      chaseId,
      type: schedule.urgency === 'normal' ? 'chase_nearby' : 'matchmaking_urgent',
      title: titles[schedule.urgency],
      body: `${wantedLevel}★ chase in ${chase.zone_name}. Pool: $${poolInfo.toLocaleString()}. ${chase.max_police - chase.current_police_count} slots open. Tap to join.`,
      data: {
        chaseId,
        wantedLevel,
        zoneName: chase.zone_name,
        cityName: chase.city_name,
        pool: chase.reward_pool,
        slotsOpen: chase.max_police - chase.current_police_count,
        urgency: schedule.urgency,
        policeTicket: chase.police_ticket,
      },
    }));

    await this.notification.sendBatch(notifications);

    // Update notified list
    const newNotifiedIds = newUsers.map(u => u.user_id);
    const allNotified = [...alreadyNotified, ...newNotifiedIds];
    await this.redis.hset(`matchmaking:${chaseId}`, 'notified_users', JSON.stringify(allNotified));

    // Log broadcast
    await this.db.query(
      `INSERT INTO matchmaking_broadcasts (chase_id, broadcast_radius_km, users_notified)
       VALUES ($1, $2, $3)`,
      [chaseId, schedule.radiusKm, newUsers.length]
    );

    console.log(`[Matchmaking] Chase ${chaseId.slice(0,8)}: broadcast to ${newUsers.length} users at ${schedule.radiusKm}km (${schedule.urgency})`);
  }

  /**
   * Police user joins a chase.
   */
  async joinChase(chaseId, userId) {
    const chase = await this.getChase(chaseId);
    if (!chase) throw new Error('Chase not found');
    if (chase.status !== 'matchmaking' && chase.status !== 'countdown') {
      throw new Error('Chase is not accepting new participants');
    }
    if (chase.current_police_count >= chase.max_police) {
      throw new Error('Chase is full');
    }

    // Check user balance
    const { rows: [user] } = await this.db.query('SELECT balance FROM users WHERE id = $1', [userId]);
    if (user.balance < chase.police_ticket) {
      throw new Error('Insufficient balance');
    }

    // Check minimum start distance (anti-collusion)
    const { rows: [wantedPos] } = await this.db.query(
      `SELECT last_known_lat, last_known_lng FROM users WHERE id = $1`,
      [chase.wanted_user_id]
    );
    const { rows: [policePos] } = await this.db.query(
      `SELECT last_known_lat, last_known_lng FROM users WHERE id = $1`,
      [userId]
    );
    
    if (wantedPos && policePos) {
      const { rows: [dist] } = await this.db.query(
        `SELECT haversine_distance($1, $2, $3, $4) as distance_m`,
        [wantedPos.last_known_lat, wantedPos.last_known_lng, policePos.last_known_lat, policePos.last_known_lng]
      );

      if (dist.distance_m < 2000) {
        throw new Error('Too close to target. Must be 2km+ away to join. Anti-collusion policy.');
      }
    }

    // Freeze fee from wallet
    await this.db.query(
      `UPDATE users SET balance = balance - $2, frozen_balance = frozen_balance + $2 WHERE id = $1`,
      [userId, chase.police_ticket]
    );

    // Create participant record
    await this.db.query(
      `INSERT INTO chase_participants (chase_id, user_id, fee_paid, start_distance_m, status)
       VALUES ($1, $2, $3, $4, 'queued')`,
      [chaseId, userId, chase.police_ticket, wantedPos && policePos ? (await this.db.query(
        `SELECT haversine_distance($1, $2, $3, $4) as d`,
        [wantedPos.last_known_lat, wantedPos.last_known_lng, policePos.last_known_lat, policePos.last_known_lng]
      )).rows[0].d : null]
    );

    // Update pool
    const newTotal = chase.total_pool + chase.police_ticket;
    const platformFee = Math.round(newTotal * 0.15);
    const rewardPool = newTotal - platformFee;
    
    await this.db.query(
      `UPDATE chases SET current_police_count = current_police_count + 1,
       total_pool = $2, platform_fee = $3, reward_pool = $4 WHERE id = $1`,
      [chaseId, newTotal, platformFee, rewardPool]
    );

    // Record transaction
    await this.db.query(
      `INSERT INTO transactions (user_id, chase_id, type, amount, balance_after, description)
       VALUES ($1, $2, 'chase_fee_police', $3, (SELECT balance FROM users WHERE id = $1), $4)`,
      [userId, chaseId, -chase.police_ticket, `Police ticket for ${chase.wanted_level}★ chase`]
    );

    // Update matchmaking broadcast log
    await this.db.query(
      `UPDATE matchmaking_broadcasts SET users_joined = users_joined + 1 
       WHERE chase_id = $1 ORDER BY broadcast_at DESC LIMIT 1`,
      [chaseId]
    );

    // Check if we can start
    const updatedChase = await this.getChase(chaseId);
    if (updatedChase.current_police_count >= updatedChase.min_police_required && updatedChase.status === 'matchmaking') {
      await this.startCountdown(chaseId);
    }

    return { joined: true, poolTotal: rewardPool };
  }

  /**
   * Transition from matchmaking to countdown.
   */
  async startCountdown(chaseId) {
    await this.db.query(
      `UPDATE chases SET status = 'countdown', phase_started_at = NOW() WHERE id = $1 AND status = 'matchmaking'`,
      [chaseId]
    );

    // Notify all participants
    const { rows: participants } = await this.db.query(
      `SELECT user_id FROM chase_participants WHERE chase_id = $1`, [chaseId]
    );
    const chase = await this.getChase(chaseId);

    const notifications = [
      { userId: chase.wanted_user_id, chaseId, type: 'chase_starting', title: '🏁 CHASE STARTING IN 60s', body: `${chase.current_police_count} police units locked in. Get ready to run.` },
      ...participants.map(p => ({
        userId: p.user_id, chaseId, type: 'chase_starting',
        title: '🏁 PURSUIT STARTING IN 60s',
        body: `Target locked. ${chase.current_police_count} units in pursuit. Stand by.`,
      }))
    ];
    await this.notification.sendBatch(notifications);

    // Clean up matchmaking state
    await this.redis.del(`matchmaking:${chaseId}`);

    console.log(`[Matchmaking] Chase ${chaseId.slice(0,8)}: countdown started with ${chase.current_police_count} police`);
  }

  /**
   * Cancel a chase that couldn't fill.
   */
  async cancelMatchmaking(chaseId, reason) {
    await this.db.query(
      `UPDATE chases SET status = 'cancelled', end_reason = $2, chase_ended_at = NOW() WHERE id = $1`,
      [chaseId, `matchmaking_${reason}`]
    );

    // Refund all participants
    const chase = await this.getChase(chaseId);
    
    // Refund wanted
    await this.db.query(
      `UPDATE users SET balance = balance + $2, frozen_balance = frozen_balance - $2 WHERE id = $1`,
      [chase.wanted_user_id, chase.wanted_fee]
    );

    // Refund police
    const { rows: participants } = await this.db.query(
      `SELECT user_id, fee_paid FROM chase_participants WHERE chase_id = $1`, [chaseId]
    );
    for (const p of participants) {
      await this.db.query(
        `UPDATE users SET balance = balance + $2, frozen_balance = frozen_balance - $2 WHERE id = $1`,
        [p.user_id, p.fee_paid]
      );
      await this.db.query(
        `UPDATE chase_participants SET fee_refunded = TRUE, status = 'completed' WHERE chase_id = $1 AND user_id = $2`,
        [chaseId, p.user_id]
      );
    }

    // Notify everyone
    await this.notification.sendBatch([
      { userId: chase.wanted_user_id, chaseId, type: 'chase_ended', title: 'Chase Cancelled', body: 'Not enough police joined. Full refund issued.' },
      ...participants.map(p => ({ userId: p.user_id, chaseId, type: 'chase_ended', title: 'Chase Cancelled', body: 'Chase was cancelled. Full refund issued.' }))
    ]);

    await this.redis.del(`matchmaking:${chaseId}`);
    console.log(`[Matchmaking] Chase ${chaseId.slice(0,8)}: cancelled (${reason}), all fees refunded`);
  }

  async getChase(chaseId) {
    const { rows: [chase] } = await this.db.query(`SELECT * FROM v_active_chases WHERE id = $1`, [chaseId]);
    return chase || (await this.db.query('SELECT * FROM chases WHERE id = $1', [chaseId])).rows[0];
  }
}
