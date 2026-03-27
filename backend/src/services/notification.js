// ═══════════════════════════════════════════════════════════════
// NOTIFICATION SERVICE
// Push (FCM/APNS) + In-app WebSocket + Database-backed
// ═══════════════════════════════════════════════════════════════

export class NotificationService {
  constructor(db, redis, firebaseAdmin) {
    this.db = db;
    this.redis = redis;
    this.firebase = firebaseAdmin;
    this.io = null; // Set by socket setup
  }

  setIO(io) {
    this.io = io;
  }

  /**
   * Send a single notification (push + socket + DB).
   */
  async send({ userId, chaseId, type, title, body, data = {} }) {
    // 1. Store in DB
    const { rows: [notification] } = await this.db.query(
      `INSERT INTO notifications (user_id, chase_id, type, title, body, data_json)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, chaseId, type, title, body, JSON.stringify(data)]
    );

    // 2. Send via WebSocket (if user is connected)
    if (this.io) {
      this.io.to(`user:${userId}`).emit('notification', {
        id: notification.id,
        type, title, body, data, chaseId,
        createdAt: notification.created_at,
      });
      await this.db.query(
        `UPDATE notifications SET sent_via_socket = TRUE WHERE id = $1`,
        [notification.id]
      );
    }

    // 3. Send via FCM push notification
    const { rows: [user] } = await this.db.query(
      'SELECT fcm_token, apns_token FROM users WHERE id = $1', [userId]
    );

    if (user?.fcm_token && this.firebase) {
      try {
        await this.firebase.messaging().send({
          token: user.fcm_token,
          notification: { title, body },
          data: {
            type,
            chaseId: chaseId || '',
            ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
          },
          android: {
            priority: data.urgency === 'critical' ? 'high' : 'normal',
            notification: {
              channelId: type.includes('urgent') || type.includes('nearby') ? 'chase_alerts' : 'general',
              sound: data.urgency === 'critical' ? 'siren.mp3' : 'default',
              vibrateTimingsMillis: data.urgency === 'critical' ? [0, 500, 200, 500] : [0, 300],
            },
          },
          apns: {
            payload: {
              aps: {
                sound: data.urgency === 'critical' ? 'siren.aiff' : 'default',
                badge: 1,
                'interruption-level': data.urgency === 'critical' ? 'critical' : 'active',
              },
            },
          },
        });
        await this.db.query(
          `UPDATE notifications SET sent_via_push = TRUE WHERE id = $1`,
          [notification.id]
        );
      } catch (err) {
        // Token might be invalid — don't fail the whole notification
        if (err.code === 'messaging/invalid-registration-token' || 
            err.code === 'messaging/registration-token-not-registered') {
          await this.db.query('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]);
        }
        console.error(`[Notification] FCM error for user ${userId.slice(0,8)}:`, err.code);
      }
    }

    return notification;
  }

  /**
   * Send batch notifications efficiently.
   */
  async sendBatch(notifications) {
    // Group by type for efficient DB inserts
    const results = [];
    
    // Use FCM batch sending (up to 500 per batch)
    const fcmMessages = [];
    
    for (const n of notifications) {
      // Store in DB
      const { rows: [saved] } = await this.db.query(
        `INSERT INTO notifications (user_id, chase_id, type, title, body, data_json)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [n.userId, n.chaseId, n.type, n.title, n.body, JSON.stringify(n.data || {})]
      );

      // Socket
      if (this.io) {
        this.io.to(`user:${n.userId}`).emit('notification', {
          id: saved.id,
          type: n.type, title: n.title, body: n.body,
          data: n.data, chaseId: n.chaseId,
        });
      }

      // Collect FCM tokens
      const { rows: [user] } = await this.db.query(
        'SELECT fcm_token FROM users WHERE id = $1', [n.userId]
      );
      if (user?.fcm_token) {
        fcmMessages.push({
          token: user.fcm_token,
          notification: { title: n.title, body: n.body },
          data: { type: n.type, chaseId: n.chaseId || '' },
        });
      }

      results.push(saved);
    }

    // Send FCM batch
    if (fcmMessages.length > 0) {
      try {
        const batchResponse = await this.firebase.messaging().sendEach(fcmMessages);
        console.log(`[Notification] Batch sent: ${batchResponse.successCount}/${fcmMessages.length} delivered`);
      } catch (err) {
        console.error('[Notification] Batch FCM error:', err);
      }
    }

    return results;
  }

  /**
   * Send chase-specific alerts (zone shrink, geofence warning, etc.)
   */
  async sendChaseAlert(chaseId, type, { targetUserId, title, body, data = {} }) {
    if (targetUserId) {
      return this.send({ userId: targetUserId, chaseId, type, title, body, data });
    }

    // Send to all participants in the chase
    const { rows } = await this.db.query(
      `SELECT user_id FROM chase_participants WHERE chase_id = $1 AND status = 'active'
       UNION SELECT wanted_user_id FROM chases WHERE id = $1`,
      [chaseId]
    );

    return this.sendBatch(rows.map(r => ({
      userId: r.user_id || r.wanted_user_id,
      chaseId, type, title, body, data,
    })));
  }

  /**
   * Get unread notifications for a user.
   */
  async getUnread(userId, limit = 20) {
    const { rows } = await this.db.query(
      `SELECT * FROM notifications WHERE user_id = $1 AND read_at IS NULL 
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }

  /**
   * Mark notification as read / acted on.
   */
  async markRead(notificationId, userId) {
    await this.db.query(
      `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
  }

  async markActedOn(notificationId, userId) {
    await this.db.query(
      `UPDATE notifications SET acted_on = TRUE, read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );
  }
}
