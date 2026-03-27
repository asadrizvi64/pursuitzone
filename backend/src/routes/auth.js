// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES — Phone OTP authentication via Twilio
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import twilio from 'twilio';

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

export function setupAuthRoutes(db) {
  const router = Router();

  // POST /api/auth/send-otp
  router.post('/send-otp', async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: 'Phone number required' });

      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

      // Store OTP in Redis or DB
      await db.query(
        `INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO UPDATE SET code = $2, expires_at = $3`,
        [phone, code, expiresAt]
      );

      // Send via Twilio (or log to console if not configured)
      if (twilioClient && process.env.TWILIO_PHONE_NUMBER) {
        await twilioClient.messages.create({
          body: `PursuitZone: Your verification code is ${code}. Expires in 5 minutes.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phone,
        });
      } else {
        console.log(`[Auth] OTP for ${phone}: ${code}`);
      }

      res.json({ sent: true, expiresIn: 300 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/auth/verify-otp
  router.post('/verify-otp', async (req, res) => {
    try {
      const { phone, code } = req.body;
      
      const { rows: [otp] } = await db.query(
        'SELECT * FROM otp_codes WHERE phone = $1 AND code = $2 AND expires_at > NOW()',
        [phone, code]
      );

      if (!otp) return res.status(401).json({ error: 'Invalid or expired OTP' });

      // Clean up used OTP
      await db.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);

      // Find or create user
      let { rows: [user] } = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
      let isNewUser = false;

      if (!user) {
        isNewUser = true;
        const { rows: [newUser] } = await db.query(
          `INSERT INTO users (phone, display_name) VALUES ($1, $2) RETURNING *`,
          [phone, `RUNNER_${Math.random().toString(36).slice(2, 8).toUpperCase()}`]
        );
        user = newUser;
      }

      // Generate JWT
      const token = jwt.sign(
        { userId: user.id, phone: user.phone },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      res.json({ token, user, isNewUser });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/auth/register — Set display name (new users)
  router.post('/register', async (req, res) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      const { displayName } = req.body;
      if (!displayName || displayName.length < 3) {
        return res.status(400).json({ error: 'Display name must be 3+ characters' });
      }

      const { rows: [user] } = await db.query(
        'UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *',
        [decoded.userId, displayName.toUpperCase().replace(/[^A-Z0-9_]/g, '_')]
      );

      res.json({ user });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
