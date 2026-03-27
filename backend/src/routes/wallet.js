// ═══════════════════════════════════════════════════════════════
// WALLET ROUTES — Stripe payment integration
// Deposits, withdrawals, transaction history
// ═══════════════════════════════════════════════════════════════

import { Router } from 'express';
import Stripe from 'stripe';
import { authMiddleware } from '../middleware/auth.js';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

export function setupWalletRoutes(db) {
  const router = Router();
  router.use(authMiddleware.protect);

  // GET /api/wallet/balance
  router.get('/balance', async (req, res) => {
    const { rows: [user] } = await db.query(
      'SELECT balance, frozen_balance FROM users WHERE id = $1',
      [req.user.id]
    );
    res.json({
      balance: user.balance,           // Available (cents)
      frozen: user.frozen_balance,     // Locked in active chases (cents)
      total: user.balance + user.frozen_balance,
      balanceFormatted: `$${(user.balance / 100).toFixed(2)}`,
      frozenFormatted: `$${(user.frozen_balance / 100).toFixed(2)}`,
    });
  });

  // POST /api/wallet/deposit — Create Stripe PaymentIntent for deposit
  router.post('/deposit', async (req, res) => {
    try {
      const { amount } = req.body; // Amount in cents (minimum $5 = 500)
      
      if (!amount || amount < 500) {
        return res.status(400).json({ error: 'Minimum deposit is $5.00' });
      }
      if (amount > 50000000) { // $500,000 max
        return res.status(400).json({ error: 'Maximum deposit is $500,000' });
      }

      // Create or get Stripe customer
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

      // Create PaymentIntent
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: stripeCustomerId,
        metadata: {
          userId: req.user.id,
          type: 'wallet_deposit',
        },
        automatic_payment_methods: { enabled: true },
      });

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount,
      });
    } catch (err) {
      console.error('[Wallet] Deposit error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/wallet/webhook — Stripe webhook for confirming deposits
  router.post('/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;
      const userId = pi.metadata.userId;
      const amount = pi.amount;

      if (pi.metadata.type === 'wallet_deposit') {
        // Credit user's wallet
        await db.query(
          'UPDATE users SET balance = balance + $2 WHERE id = $1',
          [userId, amount]
        );

        // Record transaction
        const { rows: [user] } = await db.query('SELECT balance FROM users WHERE id = $1', [userId]);
        await db.query(
          `INSERT INTO transactions (user_id, type, amount, balance_after, description)
           VALUES ($1, 'deposit', $2, $3, $4)`,
          [userId, amount, user.balance, `Wallet deposit via Stripe (${pi.id})`]
        );

        console.log(`[Wallet] Deposit confirmed: $${(amount / 100).toFixed(2)} for user ${userId.slice(0, 8)}`);
      }
    }

    res.json({ received: true });
  });

  // POST /api/wallet/withdraw — Request withdrawal
  router.post('/withdraw', async (req, res) => {
    try {
      const { amount, method } = req.body; // method: 'bank_transfer', 'stripe'
      
      if (!amount || amount < 1000) { // Min $10 withdrawal
        return res.status(400).json({ error: 'Minimum withdrawal is $10.00' });
      }

      const { rows: [user] } = await db.query(
        'SELECT balance FROM users WHERE id = $1', [req.user.id]
      );

      if (user.balance < amount) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // Deduct from balance
      await db.query(
        'UPDATE users SET balance = balance - $2 WHERE id = $1',
        [req.user.id, amount]
      );

      // Record transaction
      const { rows: [updated] } = await db.query('SELECT balance FROM users WHERE id = $1', [req.user.id]);
      await db.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, description)
         VALUES ($1, 'withdrawal', $2, $3, $4)`,
        [req.user.id, -amount, updated.balance, `Withdrawal request via ${method}`]
      );

      // In production: initiate actual bank transfer via Stripe Connect or manual processing
      // For now, flag for manual review
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

  // GET /api/wallet/transactions — Transaction history
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
