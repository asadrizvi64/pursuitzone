# PURSUIT ZONE

Real-world GPS chase game with shrinking geofence zones, altitude-aware tagging, anti-collusion validation, and fair participation-based economy.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        MOBILE APP (Expo/RN)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ GPS +    │ │ Push     │ │ Stripe   │ │ react-native-maps │  │
│  │ Barometer│ │ Notifs   │ │ Payments │ │ (Google Maps)     │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬──────────┘  │
│       │             │            │                │              │
│  ┌────┴─────────────┴────────────┴────────────────┴──────────┐  │
│  │               Zustand State Store                          │  │
│  └──────────────────────┬────────────────────────────────────┘  │
│                         │ HTTP + WebSocket                      │
└─────────────────────────┼───────────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────────┐
│  NGINX (SSL + WS proxy) │                                       │
└─────────────────────────┼───────────────────────────────────────┘
                          │
┌─────────────────────────┼───────────────────────────────────────┐
│                    API SERVER (Express + Socket.io)              │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    CHASE ENGINE                          │    │
│  │  create → matchmake → countdown → heat → cooldown → end │    │
│  └───┬────────┬──────────┬──────────┬──────────┬───────────┘    │
│      │        │          │          │          │                  │
│  ┌───┴──┐ ┌──┴───┐ ┌───┴────┐ ┌──┴────┐ ┌──┴──────┐          │
│  │Match │ │Notif │ │Geofence│ │Anti-  │ │Economy  │          │
│  │making│ │Svc   │ │Service │ │Collus.│ │Service  │          │
│  └──────┘ └──────┘ └────────┘ └───────┘ └─────────┘          │
│                                                                  │
│  Background Jobs:                                                │
│  • Matchmaking broadcaster (30s) — expanding radius notifications│
│  • Zone shrinker (5s) — shrinks active chase geofences           │
│  • Chase timeout (3s) — phase transitions                        │
│  • Geofence checker (2s) — boundary violation detection          │
└─────────────────────────────────────────────────────────────────┘
          │              │              │
    ┌─────┴─────┐  ┌────┴────┐  ┌─────┴─────┐
    │ PostgreSQL │  │  Redis  │  │ Firebase  │
    │ + PostGIS  │  │         │  │ FCM/APNS  │
    └───────────┘  └─────────┘  └───────────┘
```

## Key Systems

### 1. Shrinking Geofence (Battle Royale)
- Zone starts at 8-12km radius, shrinks to 1.5-4km across 2-6 phases
- Higher wanted levels = more shrink phases = more pressure
- Wanted leaving zone → entire chase voided, fee forfeited
- Police leaving zone → only that unit disqualified, chase continues
- 5-second grace period + warning at 85% of radius boundary

### 2. Matchmaking + Notification Broadcasting
- Expanding radius: 5km → 10km → 20km → 40km → 80km over 5 minutes
- Each broadcast only reaches NEW users (no spam)
- Urgency escalates: normal → high → urgent → critical
- Auto-cancel after 10 minutes if minimum police not met (full refunds)
- Push notifications via FCM/APNS with custom sounds + vibration patterns

### 3. Anti-Collusion (10-Point Validation)
All checks must pass before tag button activates:
1. Start distance: must be 2km+ away when joining
2. Approach speed: must maintain 5+ km/h
3. Sustained pursuit: must pursue for 2+ minutes
4. GPS integrity: need 20+ tracking points showing real movement
5. Horizontal distance: must be within 150m
6. Vertical distance: must be within ±8m (same floor)
7. GPS accuracy: must be <50m (no spoofing)
8. Mock location: Android mock location flag check
9. Pair frequency: same wanted+police max 3 chases/day
10. Movement pattern: speed variance + heading changes + position spread

### 4. 3D Altitude-Aware Tagging
- Barometric pressure sensor + GPS altitude fusion (70/30 weighted)
- Floor-level accuracy (~3m per floor)
- Prevents false tags in parking garages, overpasses, stacked highways
- Both horizontal AND vertical proximity required for valid tag

### 5. Fair Economy (NOT Gambling)
- Wanted pays participation fee (like go-kart track)
- Police pays ticket to join (like event entry)
- All fees pool together
- Platform takes flat 15% service fee
- If caught: tagger gets 50%, support police split 35%
- If escaped: wanted collects 85%
- Stripe integration for deposits/withdrawals

## Chase Zones

| City | Zone | Start Radius | Min Radius |
|------|------|-------------|------------|
| Islamabad | Blue Area - Jinnah Ave | 12km | 2km |
| Islamabad | F-6/F-7 Sectors | 8km | 1.5km |
| Islamabad | E-11 to G-9 Belt | 10km | 2km |
| Karachi | Clifton & DHA | 14km | 2.5km |
| Karachi | Saddar & II Chundrigar | 10km | 2km |
| Karachi | Korangi Industrial | 8km | 1.5km |
| Los Angeles | Downtown LA | 15km | 3km |
| Miami | South Beach Grid | 12km | 2km |
| Tokyo | Shibuya District | 8km | 1.5km |
| Dubai | Marina Circuit | 10km | 2km |
| London | Central Loop | 11km | 2km |
| New York | Manhattan Grid | 9km | 1.5km |

## Quick Start

### Backend
```bash
cd backend
cp .env.example .env  # Fill in your keys
docker-compose up -d
```

### Mobile App
```bash
cd mobile
npm install
npx expo start
```

### Required API Keys
- Google Maps API key (iOS + Android)
- Firebase project (FCM push notifications)
- Stripe account (payments)
- Twilio account (SMS OTP)

## File Structure

```
backend/
├── docker-compose.yml          # Full infra stack
├── Dockerfile                  # API server container
├── nginx.conf                  # Reverse proxy + WebSocket
├── package.json
├── .env.example
└── src/
    ├── server.js               # Main entry + background jobs
    ├── middleware/auth.js       # JWT verification
    ├── models/
    │   ├── schema.sql          # Full PostgreSQL + PostGIS schema
    │   └── migrations.sql      # Auth + wallet additions
    ├── routes/
    │   ├── chase.js            # Chase CRUD + zones + economy endpoints
    │   ├── auth.js             # Phone OTP authentication
    │   └── wallet.js           # Stripe deposits + withdrawals
    ├── services/
    │   ├── chaseEngine.js      # Core game loop orchestrator
    │   ├── matchmaking.js      # Expanding radius broadcaster
    │   ├── notification.js     # Push + WebSocket + DB notifications
    │   ├── geofence.js         # Shrinking zone enforcement
    │   ├── antiCollusion.js    # 10-point tag validation
    │   └── economy.js          # Fair reward distribution
    └── sockets/
        └── chaseSocket.js      # Real-time GPS streaming + events

mobile/
├── App.js                      # Entry + navigation + bootstrap
├── app.json                    # Expo config + permissions
├── package.json
└── src/
    ├── store/index.js          # Zustand global state
    ├── services/
    │   ├── api.js              # HTTP + WebSocket client
    │   ├── location.js         # GPS + barometer + mock detection
    │   └── pushNotifications.js# FCM/APNS registration + channels
    ├── hooks/
    │   └── useChaseSocket.js   # Real-time chase event handler
    └── components/
        └── map/
            └── ChaseMap.js     # react-native-maps with geofence viz
```
