# PURSUIT ZONE — Free Deployment Guide

Deploy the full app (backend + mobile APK) for $0 using free tiers.

---

## STEP 1: Backend Database (Supabase — FREE)

1. Go to https://supabase.com → Create account → New Project
2. Choose a region close to you, set a DB password
3. Once created, go to **Settings → Database → Connection string (URI)**
4. Copy the URI — it looks like: `postgres://postgres.xxxx:password@aws-0-region.pooler.supabase.com:6543/postgres`
5. **Run the schema**: Go to **SQL Editor** in Supabase dashboard, paste the contents of `backend/src/models/schema.sql`, click Run
6. Then paste `backend/src/models/migrations.sql` and Run

**Supabase free tier includes:** 500MB database, PostGIS extension, 50K monthly active users

---

## STEP 2: Redis Cache (Upstash — FREE)

1. Go to https://upstash.com → Create account → Create Database
2. Choose region closest to your Supabase
3. Copy the Redis URL (looks like: `rediss://default:xxxx@us1-xxx.upstash.io:6379`)

**Upstash free tier includes:** 10K commands/day, 256MB storage

---

## STEP 3: Deploy Backend (Render — FREE)

1. Push your code to a GitHub repo
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo, select the `backend` directory as root
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node src/server.js`
   - **Plan:** Free
5. Add Environment Variables:
   - `DATABASE_URL` = your Supabase connection string from Step 1
   - `REDIS_URL` = your Upstash Redis URL from Step 2
   - `JWT_SECRET` = any random string (e.g., run `openssl rand -hex 32`)
   - `NODE_ENV` = production
   - `PORT` = 10000
6. Deploy!

Your API will be live at: `https://pursuit-zone-api.onrender.com`

**Note:** Free tier spins down after 15 min inactivity. First request takes ~30s to wake up.

---

## STEP 4: Update Mobile API URL

Edit `mobile/.env`:
```
EXPO_PUBLIC_API_URL=https://pursuit-zone-api.onrender.com
```

Or edit `mobile/src/services/api.js` and update the production URL.

---

## STEP 5: Run on Your Phone (Expo Go — FREE, INSTANT)

This is the fastest way to test on a real device:

```bash
cd mobile
npm install
npx expo start
```

Then:
- **Android:** Download "Expo Go" from Play Store → Scan the QR code
- **iOS:** Download "Expo Go" from App Store → Scan the QR code with Camera

**Important:** Your phone and computer must be on the same WiFi network.

---

## STEP 6: Build APK (EAS Build — FREE TIER)

To generate an installable APK:

```bash
# Install EAS CLI
npm install -g eas-cli

# Login to Expo (create free account at expo.dev)
eas login

# Build Android APK (free tier: 30 builds/month)
cd mobile
eas build --platform android --profile preview
```

This builds in the cloud and gives you a download link for the APK.
Install it on any Android phone.

For iOS, you need an Apple Developer account ($99/year) — not free.

---

## STEP 7 (Optional): Push Notifications

### Firebase (FREE)
1. Go to https://console.firebase.google.com → Create Project
2. Add Android app with package `io.pursuitzone.app`
3. Download `google-services.json` → put in `mobile/` directory
4. Go to Project Settings → Service Accounts → Generate New Private Key
5. Minify the JSON to one line and set as `FIREBASE_SERVICE_ACCOUNT` env var on Render

### Without Firebase
Push notifications are disabled but the app still works.
In-app notifications via WebSocket still function.

---

## STEP 8 (Optional): Payments

### Stripe Test Mode (FREE)
1. Go to https://dashboard.stripe.com → Get test API keys
2. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` on Render
3. Use test card: `4242 4242 4242 4242`

Without Stripe, the wallet shows balances but deposits/withdrawals are disabled.

---

## Quick Start (Local Dev)

```bash
# Terminal 1: Backend
cd backend
npm install
npm run dev
# Server runs on http://localhost:4000

# Terminal 2: Mobile
cd mobile
npm install
npx expo start
# Scan QR code with Expo Go app
```

For local dev without PostgreSQL/Redis:
- The backend needs at minimum a PostgreSQL database
- Use Supabase free tier even for local dev (just set the DATABASE_URL)
- Redis is optional in dev mode (server handles missing Redis gracefully)

---

## Cost Summary

| Service | Free Tier | What You Get |
|---------|-----------|--------------|
| Supabase | $0/mo | PostgreSQL + PostGIS, 500MB, API |
| Upstash | $0/mo | Redis, 10K cmd/day |
| Render | $0/mo | Node.js hosting (sleeps after 15min) |
| Expo Go | $0 | Instant device testing |
| EAS Build | $0 | 30 Android builds/month |
| Firebase | $0 | Push notifications |
| **Total** | **$0/mo** | **Full working app** |

---

## Architecture (Free Tier)

```
[Phone: Expo Go / APK]
    ↕ HTTP + WebSocket
[Render.com: Node.js API]
    ↕ SQL           ↕ Pub/Sub
[Supabase: PostgreSQL]  [Upstash: Redis]
```
