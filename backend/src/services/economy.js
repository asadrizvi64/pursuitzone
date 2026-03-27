// ═══════════════════════════════════════════════════════════════
// ECONOMY SERVICE
// Fair participation-based reward system (NOT gambling)
// ═══════════════════════════════════════════════════════════════

/*
  ECONOMY PHILOSOPHY:
  - Entry fee = participation fee (like escape room, go-kart, paintball)
  - All fees pool together
  - Platform takes flat 15% service fee
  - Remaining 85% distributed based on outcome:
    • Caught: Tagger 50%, support police split 35%
    • Escaped: Wanted gets 85%
  - Nobody "loses a bet" — you pay to play an activity
  - Rewards scale with participation count, not speculation
*/

const PLATFORM_FEE_RATE = 0.15;
const TAGGER_SHARE = 0.50;
const SUPPORT_SHARE = 0.35;
const ESCAPE_SHARE = 0.85;

const LEVEL_FEES = [
  { level: 1, wantedFee: 150000, policeTicket: 50000 },   // $1500 / $500
  { level: 2, wantedFee: 400000, policeTicket: 120000 },   // $4000 / $1200
  { level: 3, wantedFee: 1000000, policeTicket: 300000 },  // $10000 / $3000
  { level: 4, wantedFee: 2500000, policeTicket: 700000 },  // $25000 / $7000
  { level: 5, wantedFee: 6000000, policeTicket: 1500000 }, // $60000 / $15000
];

export class EconomyService {
  constructor(db) {
    this.db = db;
  }

  getLevelFees(level) {
    return LEVEL_FEES[level - 1] || LEVEL_FEES[0];
  }

  /**
   * Calculate the current prize pool breakdown.
   */
  calculatePool(wantedFee, policeTicket, policeCount) {
    const totalIn = wantedFee + (policeTicket * policeCount);
    const platformFee = Math.round(totalIn * PLATFORM_FEE_RATE);
    const pool = totalIn - platformFee;

    return {
      totalIn,
      platformFee,
      pool,
      taggerReward: Math.round(pool * TAGGER_SHARE),
      supportRewardEach: policeCount > 1 
        ? Math.round((pool * SUPPORT_SHARE) / (policeCount - 1)) 
        : 0,
      escapeReward: Math.round(pool * ESCAPE_SHARE),
    };
  }

  /**
   * Distribute rewards when a chase ends.
   */
  async distributeRewards(chaseId, outcome) {
    const { rows: [chase] } = await this.db.query('SELECT * FROM chases WHERE id = $1', [chaseId]);
    if (!chase) throw new Error('Chase not found');

    const poolCalc = this.calculatePool(chase.wanted_fee, chase.police_ticket, chase.current_police_count);

    if (outcome === 'caught') {
      // Find the tagger
      const { rows: [tagger] } = await this.db.query(
        `SELECT user_id FROM chase_participants WHERE chase_id = $1 AND status = 'tagged_target'`,
        [chaseId]
      );

      if (tagger) {
        // Pay tagger
        await this.creditUser(tagger.user_id, chaseId, poolCalc.taggerReward, 'chase_reward_tagger',
          `Tag reward for ${chase.wanted_level}★ chase`);
        await this.db.query(
          'UPDATE chase_participants SET reward_earned = $3 WHERE chase_id = $1 AND user_id = $2',
          [chaseId, tagger.user_id, poolCalc.taggerReward]
        );
      }

      // Pay support police
      if (poolCalc.supportRewardEach > 0) {
        const { rows: supporters } = await this.db.query(
          `SELECT user_id FROM chase_participants 
           WHERE chase_id = $1 AND status = 'active' AND user_id != $2`,
          [chaseId, tagger?.user_id]
        );
        for (const s of supporters) {
          await this.creditUser(s.user_id, chaseId, poolCalc.supportRewardEach, 'chase_reward_support',
            `Support reward for ${chase.wanted_level}★ chase`);
          await this.db.query(
            'UPDATE chase_participants SET reward_earned = $3, status = $4 WHERE chase_id = $1 AND user_id = $2',
            [chaseId, s.user_id, poolCalc.supportRewardEach, 'completed']
          );
        }
      }

      // Wanted loses their fee (already frozen)
      await this.db.query(
        'UPDATE users SET frozen_balance = frozen_balance - $2 WHERE id = $1',
        [chase.wanted_user_id, chase.wanted_fee]
      );

      // Update stats
      await this.db.query(
        'UPDATE users SET wanted_busts = wanted_busts + 1 WHERE id = $1',
        [chase.wanted_user_id]
      );
      if (tagger) {
        await this.db.query(
          'UPDATE users SET police_captures = police_captures + 1, police_earnings = police_earnings + $2 WHERE id = $1',
          [tagger.user_id, poolCalc.taggerReward]
        );
      }

    } else if (outcome === 'escaped') {
      // Wanted gets the escape reward
      await this.creditUser(chase.wanted_user_id, chaseId, poolCalc.escapeReward, 'chase_reward_escape',
        `Escape reward for ${chase.wanted_level}★ chase`);
      
      // Unfreeze and add reward
      await this.db.query(
        'UPDATE users SET frozen_balance = frozen_balance - $2, wanted_escapes = wanted_escapes + 1, wanted_earnings = wanted_earnings + $3 WHERE id = $1',
        [chase.wanted_user_id, chase.wanted_fee, poolCalc.escapeReward]
      );

      // Police lose their fees (already frozen)
      const { rows: participants } = await this.db.query(
        `SELECT user_id, fee_paid FROM chase_participants WHERE chase_id = $1 AND status = 'active'`,
        [chaseId]
      );
      for (const p of participants) {
        await this.db.query(
          'UPDATE users SET frozen_balance = frozen_balance - $2, police_misses = police_misses + 1 WHERE id = $1',
          [p.user_id, p.fee_paid]
        );
        await this.db.query(
          'UPDATE chase_participants SET status = $3 WHERE chase_id = $1 AND user_id = $2',
          [chaseId, p.user_id, 'completed']
        );
      }
    }

    // Platform takes its cut
    await this.db.query(
      `INSERT INTO transactions (user_id, chase_id, type, amount, balance_after, description)
       VALUES ((SELECT id FROM users LIMIT 1), $1, 'platform_fee', $2, 0, $3)`,
      [chaseId, poolCalc.platformFee, `Platform fee for ${chase.wanted_level}★ chase`]
    );

    return poolCalc;
  }

  async creditUser(userId, chaseId, amount, type, description) {
    await this.db.query('UPDATE users SET balance = balance + $2 WHERE id = $1', [userId, amount]);
    const { rows: [user] } = await this.db.query('SELECT balance FROM users WHERE id = $1', [userId]);
    await this.db.query(
      `INSERT INTO transactions (user_id, chase_id, type, amount, balance_after, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, chaseId, type, amount, user.balance, description]
    );
  }
}
