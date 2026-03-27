// ═══════════════════════════════════════════════════════════════
// WALLET ROUTES — Payment proof + Stripe integration
// Deposits via screenshot proof, withdrawals, transaction history
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';

let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    const Stripe = (await import('stripe')).default;
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
} catch (e) {
  console.warn('[Wallet] Stripe not configured — using proof-based deposits only');
}

// Admin user IDs that can approve deposits (set via env or hardcode for dev)
const ADMIN_PHONES = (process.env.ADMIN_PHONES || '').split(',').filter(Boolean);

export function setupWalletRoutes(db) {
  const router = Router();
  router.use(authMiddleware.protect);

  // ── GET /api/wallet/balance ──────────────────────
  router.get('/balance', async (req, res) => {
    const { rows: [user] } = await db.query(
      'SELECT balance, frozen_balance FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json({
      balance: user.balance,
      frozen: user.frozen_balance,
      total: user.balance + user.frozen_balance,
      balanceFormatted: `$${(user.balance / 100).toFixed(2)}`,
      frozenFormatted: `$${(user.frozen_balance / 100).toFixed(2)}`,
    });
  });

  // ── POST /api/wallet/deposit-proof ──────────────
  // Submit a deposit request with screenshot proof
  router.post('/deposit-proof', async (req, res) => {
    try {
      const { amount, paymentMethod, senderAccount, referenceNumber, screenshotBase64 } = req.body;

      if (!amount || amount < 100) {
        return res.status(400).json({ error: 'Minimum deposit is $1.00' });
      }
      if (amount > 50000000) {
        return res.status(400).json({ error: 'Maximum deposit is $500,000' });
      }
      if (!paymentMethod) {
        return res.status(400).json({ error: 'Payment method is required' });
      }
      if (!screenshotBase64) {
        return res.status(400).json({ error: 'Screenshot proof is required' });
      }
      // Basic size check (~5MB base64 limit)
      if (screenshotBase64.length > 7_000_000) {
        return res.status(400).json({ error: 'Screenshot too large. Max 5MB.' });
      }

      const { rows: [deposit] } = await db.query(
        `INSERT INTO deposit_requests (user_id, amount, payment_method, sender_account, reference_number, screenshot_data)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, amount, payment_method, status, created_at`,
        [req.user.id, amount, paymentMethod, senderAccount || null, referenceNumber || null, screenshotBase64]
      );

      console.log(`[Wallet] Deposit proof submitted: $${(amount / 100).toFixed(2)} via ${paymentMethod} by user ${req.user.id.slice(0, 8)}`);

      res.json({
        success: true,
        message: 'Deposit proof submitted. Awaiting admin approval.',
        deposit,
      });
    } catch (err) {
      console.error('[Wallet] Deposit proof error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/wallet/deposits ────────────────────
  // Get user's deposit requests
  router.get('/deposits', async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, amount, payment_method, sender_account, reference_number, status, review_note, created_at, reviewed_at
       FROM deposit_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ deposits: rows });
  });

  // ── GET /api/wallet/admin/pending ───────────────
  // Admin: get all pending deposit requests
  router.get('/admin/pending', async (req, res) => {
    try {
      // Check if user is admin
      const { rows: [caller] } = await db.query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
      const isAdmin = ADMIN_PHONES.includes(caller.phone) || process.env.NODE_ENV !== 'production';

      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { rows } = await db.query(
        `SELECT dr.*, u.display_name, u.phone
         FROM deposit_requests dr
         JOIN users u ON dr.user_id = u.id
         WHERE dr.status = 'pending'
         ORDER BY dr.created_at ASC`
      );
      res.json({ pending: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/wallet/admin/review/:id ───────────
  // Admin: approve or reject a deposit request
  router.post('/admin/review/:id', async (req, res) => {
    try {
      const { decision, note } = req.body; // decision: 'approved' | 'rejected'

      if (!['approved', 'rejected'].includes(decision)) {
        return res.status(400).json({ error: 'Decision must be "approved" or "rejected"' });
      }

      // Check if user is admin
      const { rows: [caller] } = await db.query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
      const isAdmin = ADMIN_PHONES.includes(caller.phone) || process.env.NODE_ENV !== 'production';

      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      // Get the deposit request
      const { rows: [deposit] } = await db.query(
        'SELECT * FROM deposit_requests WHERE id = $1', [req.params.id]
      );

      if (!deposit) {
        return res.status(404).json({ error: 'Deposit request not found' });
      }
      if (deposit.status !== 'pending') {
        return res.status(400).json({ error: `Already ${deposit.status}` });
      }

      // Update deposit request status
      await db.query(
        `UPDATE deposit_requests SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = NOW()
         WHERE id = $1`,
        [deposit.id, decision, req.user.id, note || null]
      );

      if (decision === 'approved') {
        // Credit user's balance
        await db.query(
          'UPDATE users SET balance = balance + $2 WHERE id = $1',
          [deposit.user_id, deposit.amount]
        );

        // Record transaction
        const { rows: [user] } = await db.query('SELECT balance FROM users WHERE id = $1', [deposit.user_id]);
        await db.query(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description)
           VALUES ($1, 'deposit', $2, $3, $4)`,
          [deposit.user_id, deposit.amount, user.balance,
           `Deposit via ${deposit.payment_method} (approved by admin)`]
        );

        console.log(`[Wallet] Deposit APPROVED: $${(deposit.amount / 100).toFixed(2)} for user ${deposit.user_id.slice(0, 8)}`);
      } else {
        console.log(`[Wallet] Deposit REJECTED: $${(deposit.amount / 100).toFixed(2)} for user ${deposit.user_id.slice(0, 8)} — ${note || 'no reason'}`);
      }

      res.json({ success: true, decision, depositId: deposit.id });
    } catch (err) {
      console.error('[Wallet] Admin review error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/wallet/deposit — Stripe (kept for production) ──
  router.post('/deposit', async (req, res) => {
    try {
      if (!stripe) return res.status(503).json({ error: 'Stripe not configured. Use deposit-proof instead.' });
      const { amount } = req.body;

      if (!amount || amount < 500) {
        return res.status(400).json({ error: 'Minimum deposit is $5.00' });
      }

      let stripeCustomerId;
      const { rows: [user] } = await db.query(
        'SELECT stripe_customer_id, email, display_name FROM users WHERE id = $1',
        [req.user.id]
      );

      if (user.stripe_customer_id) {
        stripeCustomerId = user.stripe_customer_id;
      } else {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.display_name,
          metadata: { userId: req.user.id },
        });
        stripeCustomerId = customer.id;
        await db.query(
          'UPDATE users SET stripe_customer_id = $2 WHERE id = $1',
          [req.user.id, stripeCustomerId]
        );
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: stripeCustomerId,
        metadata: { userId: req.user.id, type: 'wallet_deposit' },
        automatic_payment_methods: { enabled: true },
      });

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/wallet/withdraw ────────────────────
  router.post('/withdraw', async (req, res) => {
    try {
      const { amount, method } = req.body;

      if (!amount || amount < 1000) {
        return res.status(400).json({ error: 'Minimum withdrawal is $10.00' });
      }

      const { rows: [user] } = await db.query(
        'SELECT balance FROM users WHERE id = $1', [req.user.id]
      );

      if (user.balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      await db.query(
        'UPDATE users SET balance = balance - $2 WHERE id = $1',
        [req.user.id, amount]
      );

      const { rows: [updated] } = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
      await db.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description)
         VALUES ($1, 'withdrawal', $2, $3, $4)`,
        [req.user.id, -amount, updated.balance, `Withdrawal request via ${method}`]
      );

      console.log(`[Wallet] Withdrawal request: $${(amount / 100).toFixed(2)} for user ${req.user.id.slice(0, 8)}`);

      res.json({
        success: true,
        message: 'Withdrawal request submitted. Processing takes 2-5 business days.',
        amount,
        newBalance: updated.balance,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/wallet/transactions ─────────────────
  router.get('/transactions', async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    const { rows } = await db.query(
      `SELECT * FROM transactions WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, parseInt(limit), parseInt(offset)]
    );
    res.json({ transactions: rows });
  });

  return router;
}
