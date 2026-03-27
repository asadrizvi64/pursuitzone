-- ═══════════════════════════════════════════════════════════════
-- PURSUIT ZONE — Dev Database Schema (NO PostGIS required)
-- PostgreSQL 15+ — uses plain lat/lng, distances computed in app
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ───────────────────────────────────────────
-- USERS & PROFILES
-- ───────────────────────────────────────────

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone           VARCHAR(20) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE,
    display_name    VARCHAR(50) NOT NULL,
    avatar_url      TEXT,

    -- Dual profile stats
    wanted_rating   DECIMAL(3,2) DEFAULT 0.00,
    wanted_escapes  INT DEFAULT 0,
    wanted_busts    INT DEFAULT 0,
    wanted_earnings BIGINT DEFAULT 0,
    police_rating   DECIMAL(3,2) DEFAULT 0.00,
    police_captures INT DEFAULT 0,
    police_misses   INT DEFAULT 0,
    police_earnings BIGINT DEFAULT 0,

    -- Wallet
    balance         BIGINT DEFAULT 0,
    frozen_balance  BIGINT DEFAULT 0,

    -- Location
    last_known_lat  DOUBLE PRECISION,
    last_known_lng  DOUBLE PRECISION,
    last_known_alt  DOUBLE PRECISION,
    last_location_at TIMESTAMPTZ,
    fcm_token       TEXT,
    apns_token      TEXT,

    -- Preferences
    notify_chase_radius_km  DECIMAL(5,2) DEFAULT 10.00,
    notify_min_star_level   INT DEFAULT 1,
    notify_enabled          BOOLEAN DEFAULT TRUE,
    preferred_role          VARCHAR(10) DEFAULT 'both',

    -- Anti-fraud
    device_fingerprint  TEXT,
    trust_score         DECIMAL(3,2) DEFAULT 1.00,
    is_banned           BOOLEAN DEFAULT FALSE,
    stripe_customer_id  VARCHAR(255),

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_notify ON users(notify_enabled, is_banned) WHERE notify_enabled = TRUE AND is_banned = FALSE;
CREATE INDEX idx_users_location ON users(last_known_lat, last_known_lng) WHERE last_known_lat IS NOT NULL;

-- ───────────────────────────────────────────
-- CHASE ZONES (Pre-defined city zones)
-- ───────────────────────────────────────────

CREATE TABLE chase_zones (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    city_name       VARCHAR(100) NOT NULL,
    zone_name       VARCHAR(100) NOT NULL,
    center_lat      DOUBLE PRECISION NOT NULL,
    center_lng      DOUBLE PRECISION NOT NULL,
    max_radius_km   DECIMAL(5,2) NOT NULL,
    min_radius_km   DECIMAL(5,2) NOT NULL,
    country_code    VARCHAR(3),
    timezone        VARCHAR(50),
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO chase_zones (city_name, zone_name, center_lat, center_lng, max_radius_km, min_radius_km, country_code, timezone) VALUES
('Islamabad', 'Blue Area - Jinnah Avenue', 33.7104, 73.0561, 12, 2, 'PK', 'Asia/Karachi'),
('Islamabad', 'F-6/F-7 Sectors', 33.7213, 73.0327, 8, 1.5, 'PK', 'Asia/Karachi'),
('Islamabad', 'E-11 to G-9 Belt', 33.6967, 73.0153, 10, 2, 'PK', 'Asia/Karachi'),
('Karachi', 'Clifton & DHA', 24.8045, 67.0420, 14, 2.5, 'PK', 'Asia/Karachi'),
('Karachi', 'Saddar & II Chundrigar', 24.8508, 67.0099, 10, 2, 'PK', 'Asia/Karachi'),
('Karachi', 'Korangi Industrial', 24.8307, 67.1284, 8, 1.5, 'PK', 'Asia/Karachi'),
('Los Angeles', 'Downtown LA', 34.0522, -118.2437, 15, 3, 'US', 'America/Los_Angeles'),
('Miami', 'South Beach Grid', 25.7617, -80.1918, 12, 2, 'US', 'America/New_York'),
('Tokyo', 'Shibuya District', 35.6762, 139.6503, 8, 1.5, 'JP', 'Asia/Tokyo'),
('Dubai', 'Marina Circuit', 25.2048, 55.2708, 10, 2, 'AE', 'Asia/Dubai'),
('London', 'Central Loop', 51.5074, -0.1278, 11, 2, 'GB', 'Europe/London'),
('New York', 'Manhattan Grid', 40.7128, -74.006, 9, 1.5, 'US', 'America/New_York');

-- ───────────────────────────────────────────
-- CHASES (Core game sessions)
-- ───────────────────────────────────────────

CREATE TYPE chase_status AS ENUM (
    'matchmaking', 'countdown', 'heat', 'cooldown', 'escalating',
    'caught', 'escaped', 'voided_geofence', 'surrendered', 'cancelled'
);

CREATE TABLE chases (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wanted_user_id  UUID NOT NULL REFERENCES users(id),
    wanted_level    INT NOT NULL CHECK (wanted_level BETWEEN 1 AND 5),

    zone_id         UUID NOT NULL REFERENCES chase_zones(id),
    start_radius_km DECIMAL(5,2) NOT NULL,
    current_radius_km DECIMAL(5,2) NOT NULL,
    min_radius_km   DECIMAL(5,2) NOT NULL,
    shrink_phases   INT NOT NULL,
    current_shrink_phase INT DEFAULT 0,
    zone_center_lat DOUBLE PRECISION NOT NULL,
    zone_center_lng DOUBLE PRECISION NOT NULL,

    heat_duration_sec    INT NOT NULL,
    cooldown_duration_sec INT NOT NULL,
    phase_started_at     TIMESTAMPTZ,
    chase_started_at     TIMESTAMPTZ,
    chase_ended_at       TIMESTAMPTZ,
    next_shrink_at       TIMESTAMPTZ,

    wanted_fee       BIGINT NOT NULL,
    police_ticket    BIGINT NOT NULL,
    total_pool       BIGINT DEFAULT 0,
    platform_fee     BIGINT DEFAULT 0,
    reward_pool      BIGINT DEFAULT 0,

    min_police_required INT NOT NULL DEFAULT 1,
    max_police          INT NOT NULL,
    current_police_count INT DEFAULT 0,
    matchmaking_started_at TIMESTAMPTZ,
    matchmaking_broadcast_radius_km DECIMAL(5,2) DEFAULT 5.0,
    matchmaking_escalation_count INT DEFAULT 0,

    status          chase_status NOT NULL DEFAULT 'matchmaking',
    end_reason      TEXT,

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chases_status ON chases(status) WHERE status IN ('matchmaking', 'countdown', 'heat', 'cooldown');
CREATE INDEX idx_chases_location ON chases(zone_center_lat, zone_center_lng);

-- ───────────────────────────────────────────
-- CHASE PARTICIPANTS
-- ───────────────────────────────────────────

CREATE TYPE participant_status AS ENUM (
    'queued', 'active', 'tagged_target', 'disqualified', 'withdrew', 'completed'
);

CREATE TABLE chase_participants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    user_id         UUID NOT NULL REFERENCES users(id),

    fee_paid        BIGINT NOT NULL,
    reward_earned   BIGINT DEFAULT 0,
    fee_refunded    BOOLEAN DEFAULT FALSE,

    start_distance_m     DOUBLE PRECISION,
    min_approach_speed   DOUBLE PRECISION,
    sustained_pursuit_sec INT DEFAULT 0,
    gps_tracking_points  INT DEFAULT 0,
    altitude_at_tag      DOUBLE PRECISION,

    tag_attempted_at     TIMESTAMPTZ,
    tag_horizontal_dist  DOUBLE PRECISION,
    tag_vertical_dist    DOUBLE PRECISION,
    tag_validated        BOOLEAN DEFAULT FALSE,

    status          participant_status NOT NULL DEFAULT 'queued',
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    left_at         TIMESTAMPTZ,
    disqualify_reason TEXT,

    UNIQUE(chase_id, user_id)
);

CREATE INDEX idx_participants_chase ON chase_participants(chase_id, status);
CREATE INDEX idx_participants_user ON chase_participants(user_id, status);

-- ───────────────────────────────────────────
-- GPS TRACKING
-- ───────────────────────────────────────────

CREATE TABLE gps_tracks (
    id              BIGSERIAL PRIMARY KEY,
    chase_id        UUID NOT NULL REFERENCES chases(id),
    user_id         UUID NOT NULL REFERENCES users(id),

    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    altitude        DOUBLE PRECISION,
    accuracy        DOUBLE PRECISION,
    speed           DOUBLE PRECISION,
    heading         DOUBLE PRECISION,

    altitude_source VARCHAR(20),
    is_mock_location BOOLEAN DEFAULT FALSE,

    recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gps_chase_user ON gps_tracks(chase_id, user_id, recorded_at DESC);

-- ───────────────────────────────────────────
-- NOTIFICATIONS
-- ───────────────────────────────────────────

CREATE TYPE notification_type AS ENUM (
    'chase_nearby', 'matchmaking_urgent', 'chase_starting', 'zone_shrinking',
    'tag_attempt', 'chase_ended', 'reward_received', 'reinforcement_request',
    'geofence_warning', 'altitude_warning'
);

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    chase_id        UUID REFERENCES chases(id),
    type            notification_type NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    data_json       JSONB,
    sent_via_push   BOOLEAN DEFAULT FALSE,
    sent_via_socket BOOLEAN DEFAULT FALSE,
    read_at         TIMESTAMPTZ,
    acted_on        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE matchmaking_broadcasts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    broadcast_radius_km DECIMAL(5,2) NOT NULL,
    users_notified  INT DEFAULT 0,
    users_joined    INT DEFAULT 0,
    broadcast_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────
-- TRANSACTIONS
-- ───────────────────────────────────────────

CREATE TYPE txn_type AS ENUM (
    'deposit', 'withdrawal', 'chase_fee_wanted', 'chase_fee_police',
    'chase_reward_escape', 'chase_reward_tagger', 'chase_reward_support',
    'chase_refund', 'platform_fee', 'freeze', 'unfreeze'
);

CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    chase_id        UUID REFERENCES chases(id),
    type            txn_type NOT NULL,
    amount          BIGINT NOT NULL,
    balance_after   BIGINT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_txn_user ON transactions(user_id, created_at DESC);

-- ───────────────────────────────────────────
-- ZONE SHRINK EVENTS
-- ───────────────────────────────────────────

CREATE TABLE zone_shrink_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    phase_number    INT NOT NULL,
    previous_radius_km DECIMAL(5,2) NOT NULL,
    new_radius_km   DECIMAL(5,2) NOT NULL,
    users_outside   INT DEFAULT 0,
    shrunk_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────
-- GEOFENCE VIOLATIONS
-- ───────────────────────────────────────────

CREATE TABLE geofence_violations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    role            VARCHAR(10) NOT NULL,
    distance_from_center_m  DOUBLE PRECISION,
    zone_radius_at_time_m   DOUBLE PRECISION,
    overshoot_m             DOUBLE PRECISION,
    chase_voided    BOOLEAN DEFAULT FALSE,
    unit_disqualified BOOLEAN DEFAULT FALSE,
    fee_forfeited   BOOLEAN DEFAULT FALSE,
    detected_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────
-- ANTI-COLLUSION FLAGS
-- ───────────────────────────────────────────

CREATE TABLE collusion_flags (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    flagged_user_id UUID NOT NULL REFERENCES users(id),
    flag_type       VARCHAR(50) NOT NULL,
    details_json    JSONB,
    severity        INT DEFAULT 1,
    auto_resolved   BOOLEAN DEFAULT FALSE,
    reviewed_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────
-- DEPOSIT REQUESTS (Screenshot-based payment proof)
-- ───────────────────────────────────────────

CREATE TYPE deposit_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE deposit_requests (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    amount          BIGINT NOT NULL,
    payment_method  VARCHAR(50) NOT NULL,
    sender_account  VARCHAR(100),
    reference_number VARCHAR(100),
    screenshot_data TEXT NOT NULL,
    status          deposit_status NOT NULL DEFAULT 'pending',
    reviewed_by     UUID REFERENCES users(id),
    review_note     TEXT,
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_deposit_requests_user ON deposit_requests(user_id, created_at DESC);
CREATE INDEX idx_deposit_requests_status ON deposit_requests(status) WHERE status = 'pending';

-- ───────────────────────────────────────────
-- OTP CODES
-- ───────────────────────────────────────────

CREATE TABLE otp_codes (
    phone       VARCHAR(20) PRIMARY KEY,
    code        VARCHAR(6) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────
-- VIEW: Active chases (no PostGIS)
-- ───────────────────────────────────────────

CREATE VIEW v_active_chases AS
SELECT
    c.*,
    z.city_name,
    z.zone_name,
    u.display_name AS wanted_name,
    c.current_police_count AS police_joined,
    c.max_police - c.current_police_count AS police_slots_open,
    ROUND(c.reward_pool * 0.50) AS tagger_reward,
    CASE WHEN c.current_police_count > 1
        THEN ROUND((c.reward_pool * 0.35) / (c.current_police_count - 1))
        ELSE 0 END AS support_reward,
    ROUND(c.reward_pool * 0.85) AS escape_reward
FROM chases c
JOIN chase_zones z ON c.zone_id = z.id
JOIN users u ON c.wanted_user_id = u.id
WHERE c.status IN ('matchmaking', 'countdown', 'heat', 'cooldown');

-- ───────────────────────────────────────────
-- Haversine distance function (replaces PostGIS ST_Distance)
-- Returns distance in METERS between two lat/lng points
-- ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION haversine_distance(
    lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION,
    lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION AS $$
DECLARE
    R CONSTANT DOUBLE PRECISION := 6371000; -- Earth radius in meters
    dlat DOUBLE PRECISION;
    dlng DOUBLE PRECISION;
    a DOUBLE PRECISION;
BEGIN
    dlat := RADIANS(lat2 - lat1);
    dlng := RADIANS(lng2 - lng1);
    a := SIN(dlat / 2) ^ 2 + COS(RADIANS(lat1)) * COS(RADIANS(lat2)) * SIN(dlng / 2) ^ 2;
    RETURN R * 2 * ATAN2(SQRT(a), SQRT(1 - a));
END;
$$ LANGUAGE plpgsql IMMUTABLE;
