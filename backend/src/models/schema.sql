-- ═══════════════════════════════════════════════════════════════
-- PURSUIT ZONE — Complete Database Schema
-- PostgreSQL 15+ with PostGIS extension for geospatial queries
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";

-- ───────────────────────────────────────────
-- USERS & PROFILES
-- ───────────────────────────────────────────

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone           VARCHAR(20) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE,
    display_name    VARCHAR(50) NOT NULL,
    avatar_url      TEXT,
    
    -- Dual profile stats (Fiverr-style: same account, two roles)
    wanted_rating   DECIMAL(3,2) DEFAULT 0.00,
    wanted_escapes  INT DEFAULT 0,
    wanted_busts    INT DEFAULT 0,
    wanted_earnings BIGINT DEFAULT 0,        -- cents
    police_rating   DECIMAL(3,2) DEFAULT 0.00,
    police_captures INT DEFAULT 0,
    police_misses   INT DEFAULT 0,
    police_earnings BIGINT DEFAULT 0,        -- cents
    
    -- Wallet
    balance         BIGINT DEFAULT 0,        -- cents
    frozen_balance  BIGINT DEFAULT 0,        -- locked during active chases
    
    -- Location & Notifications
    last_known_lat  DOUBLE PRECISION,
    last_known_lng  DOUBLE PRECISION,
    last_known_alt  DOUBLE PRECISION,        -- altitude in meters (barometric + GPS fused)
    last_location_at TIMESTAMPTZ,
    location_geom   GEOGRAPHY(Point, 4326),  -- PostGIS geometry for spatial queries
    fcm_token       TEXT,                    -- Firebase Cloud Messaging token
    apns_token      TEXT,                    -- Apple Push Notification token
    
    -- Preferences
    notify_chase_radius_km  DECIMAL(5,2) DEFAULT 10.00,
    notify_min_star_level   INT DEFAULT 1,
    notify_enabled          BOOLEAN DEFAULT TRUE,
    preferred_role          VARCHAR(10) DEFAULT 'both', -- 'wanted', 'police', 'both'
    
    -- Anti-fraud
    device_fingerprint  TEXT,
    trust_score         DECIMAL(3,2) DEFAULT 1.00,  -- 0-1, decremented on fraud flags
    is_banned           BOOLEAN DEFAULT FALSE,
    
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_location ON users USING GIST(location_geom);
CREATE INDEX idx_users_notify ON users(notify_enabled, is_banned) WHERE notify_enabled = TRUE AND is_banned = FALSE;

-- ───────────────────────────────────────────
-- CHASE ZONES (Pre-defined city zones)
-- ───────────────────────────────────────────

CREATE TABLE chase_zones (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    city_name       VARCHAR(100) NOT NULL,
    zone_name       VARCHAR(100) NOT NULL,
    center_lat      DOUBLE PRECISION NOT NULL,
    center_lng      DOUBLE PRECISION NOT NULL,
    center_geom     GEOGRAPHY(Point, 4326),
    max_radius_km   DECIMAL(5,2) NOT NULL,
    min_radius_km   DECIMAL(5,2) NOT NULL,
    country_code    VARCHAR(3),
    timezone        VARCHAR(50),
    is_active       BOOLEAN DEFAULT TRUE,
    
    -- Geofence boundary polygon (actual city boundary, not just circle)
    boundary_geom   GEOGRAPHY(Polygon, 4326),
    
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
    'matchmaking',     -- Waiting for enough police to join
    'countdown',       -- 60s countdown before chase starts
    'heat',            -- Active chase, heat phase
    'cooldown',        -- Cooldown phase after heat expires
    'escalating',      -- Wanted chose to increase level
    'caught',          -- Police tagged the wanted
    'escaped',         -- Wanted survived all phases
    'voided_geofence', -- Wanted left the zone
    'surrendered',     -- Wanted surrendered
    'cancelled'        -- Cancelled during matchmaking (refunds issued)
);

CREATE TABLE chases (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Wanted vehicle
    wanted_user_id  UUID NOT NULL REFERENCES users(id),
    wanted_level    INT NOT NULL CHECK (wanted_level BETWEEN 1 AND 5),
    
    -- Zone
    zone_id         UUID NOT NULL REFERENCES chase_zones(id),
    start_radius_km DECIMAL(5,2) NOT NULL,
    current_radius_km DECIMAL(5,2) NOT NULL,
    min_radius_km   DECIMAL(5,2) NOT NULL,
    shrink_phases   INT NOT NULL,
    current_shrink_phase INT DEFAULT 0,
    zone_center_lat DOUBLE PRECISION NOT NULL,
    zone_center_lng DOUBLE PRECISION NOT NULL,
    zone_center_geom GEOGRAPHY(Point, 4326),
    
    -- Timing
    heat_duration_sec    INT NOT NULL,
    cooldown_duration_sec INT NOT NULL,
    phase_started_at     TIMESTAMPTZ,
    chase_started_at     TIMESTAMPTZ,
    chase_ended_at       TIMESTAMPTZ,
    next_shrink_at       TIMESTAMPTZ,
    
    -- Economy
    wanted_fee       BIGINT NOT NULL,     -- cents
    police_ticket    BIGINT NOT NULL,     -- cents
    total_pool       BIGINT DEFAULT 0,    -- cents, updated as police join
    platform_fee     BIGINT DEFAULT 0,    -- 15%
    reward_pool      BIGINT DEFAULT 0,    -- 85%
    
    -- Matchmaking
    min_police_required INT NOT NULL DEFAULT 1,
    max_police          INT NOT NULL,
    current_police_count INT DEFAULT 0,
    matchmaking_started_at TIMESTAMPTZ,
    matchmaking_broadcast_radius_km DECIMAL(5,2) DEFAULT 5.0,
    matchmaking_escalation_count INT DEFAULT 0,
    
    -- Status
    status          chase_status NOT NULL DEFAULT 'matchmaking',
    end_reason      TEXT,
    
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_chases_status ON chases(status) WHERE status IN ('matchmaking', 'countdown', 'heat', 'cooldown');
CREATE INDEX idx_chases_location ON chases USING GIST(zone_center_geom);
CREATE INDEX idx_chases_matchmaking ON chases(status, matchmaking_broadcast_radius_km) WHERE status = 'matchmaking';

-- ───────────────────────────────────────────
-- CHASE PARTICIPANTS (Police units in a chase)
-- ───────────────────────────────────────────

CREATE TYPE participant_status AS ENUM (
    'queued',          -- In matchmaking queue
    'active',          -- In the chase
    'tagged_target',   -- This unit tagged the wanted
    'disqualified',    -- Left the zone / fraud detected
    'withdrew',        -- Voluntarily left
    'completed'        -- Chase ended normally
);

CREATE TABLE chase_participants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    
    -- Fee & Rewards
    fee_paid        BIGINT NOT NULL,     -- cents
    reward_earned   BIGINT DEFAULT 0,    -- cents
    fee_refunded    BOOLEAN DEFAULT FALSE,
    
    -- Anti-collusion tracking
    start_distance_m     DOUBLE PRECISION,  -- distance from wanted when joined
    min_approach_speed   DOUBLE PRECISION,  -- km/h, minimum speed during approach
    sustained_pursuit_sec INT DEFAULT 0,    -- seconds of genuine pursuit
    gps_tracking_points  INT DEFAULT 0,     -- number of GPS pings with real movement
    altitude_at_tag      DOUBLE PRECISION,  -- altitude when tag attempted
    
    -- Tag attempt
    tag_attempted_at     TIMESTAMPTZ,
    tag_horizontal_dist  DOUBLE PRECISION,  -- meters
    tag_vertical_dist    DOUBLE PRECISION,  -- meters (altitude diff)
    tag_validated        BOOLEAN DEFAULT FALSE,
    
    -- Status
    status          participant_status NOT NULL DEFAULT 'queued',
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    left_at         TIMESTAMPTZ,
    disqualify_reason TEXT,
    
    UNIQUE(chase_id, user_id)
);

CREATE INDEX idx_participants_chase ON chase_participants(chase_id, status);
CREATE INDEX idx_participants_user ON chase_participants(user_id, status);

-- ───────────────────────────────────────────
-- GPS TRACKING (Real-time location log)
-- ───────────────────────────────────────────

CREATE TABLE gps_tracks (
    id              BIGSERIAL PRIMARY KEY,
    chase_id        UUID NOT NULL REFERENCES chases(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    altitude        DOUBLE PRECISION,          -- meters, barometric + GPS fused
    accuracy        DOUBLE PRECISION,          -- GPS accuracy in meters
    speed           DOUBLE PRECISION,          -- km/h
    heading         DOUBLE PRECISION,          -- degrees
    
    -- Anti-spoof
    altitude_source VARCHAR(20),               -- 'barometric', 'gps', 'fused'
    is_mock_location BOOLEAN DEFAULT FALSE,    -- Android mock location flag
    
    geom            GEOGRAPHY(Point, 4326),
    recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gps_chase_user ON gps_tracks(chase_id, user_id, recorded_at DESC);
CREATE INDEX idx_gps_location ON gps_tracks USING GIST(geom);

-- Partition by month for performance (billions of rows expected)
-- CREATE TABLE gps_tracks_2026_03 PARTITION OF gps_tracks FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- ───────────────────────────────────────────
-- NOTIFICATIONS & MATCHMAKING
-- ───────────────────────────────────────────

CREATE TYPE notification_type AS ENUM (
    'chase_nearby',           -- A new chase was created near you
    'matchmaking_urgent',     -- Chase needs more police urgently
    'chase_starting',         -- Chase you joined is starting
    'zone_shrinking',         -- Zone is about to shrink
    'tag_attempt',            -- Someone attempted to tag you
    'chase_ended',            -- Chase you were in ended
    'reward_received',        -- You received a reward
    'reinforcement_request',  -- Backup requested
    'geofence_warning',       -- You're approaching zone boundary
    'altitude_warning'        -- Altitude mismatch with target
);

CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    chase_id        UUID REFERENCES chases(id),
    type            notification_type NOT NULL,
    
    title           TEXT NOT NULL,
    body            TEXT NOT NULL,
    data_json       JSONB,                     -- Additional payload for the app
    
    -- Delivery
    sent_via_push   BOOLEAN DEFAULT FALSE,
    sent_via_socket BOOLEAN DEFAULT FALSE,
    read_at         TIMESTAMPTZ,
    acted_on        BOOLEAN DEFAULT FALSE,     -- Did user click "Join" etc.
    
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_chase ON notifications(chase_id) WHERE chase_id IS NOT NULL;

-- Matchmaking broadcast log (tracks expanding radius notifications)
CREATE TABLE matchmaking_broadcasts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    broadcast_radius_km DECIMAL(5,2) NOT NULL,
    users_notified  INT DEFAULT 0,
    users_joined    INT DEFAULT 0,
    broadcast_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────
-- TRANSACTIONS (Financial ledger)
-- ───────────────────────────────────────────

CREATE TYPE txn_type AS ENUM (
    'deposit',
    'withdrawal',
    'chase_fee_wanted',
    'chase_fee_police',
    'chase_reward_escape',
    'chase_reward_tagger',
    'chase_reward_support',
    'chase_refund',
    'platform_fee',
    'freeze',
    'unfreeze'
);

CREATE TABLE transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    chase_id        UUID REFERENCES chases(id),
    type            txn_type NOT NULL,
    amount          BIGINT NOT NULL,           -- positive = credit, negative = debit (cents)
    balance_after   BIGINT NOT NULL,           -- balance after this txn (cents)
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_txn_user ON transactions(user_id, created_at DESC);
CREATE INDEX idx_txn_chase ON transactions(chase_id) WHERE chase_id IS NOT NULL;

-- ───────────────────────────────────────────
-- ZONE SHRINK EVENTS
-- ───────────────────────────────────────────

CREATE TABLE zone_shrink_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    phase_number    INT NOT NULL,
    previous_radius_km DECIMAL(5,2) NOT NULL,
    new_radius_km   DECIMAL(5,2) NOT NULL,
    users_outside   INT DEFAULT 0,             -- how many were caught outside
    shrunk_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────
-- GEOFENCE VIOLATIONS
-- ───────────────────────────────────────────

CREATE TABLE geofence_violations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chase_id        UUID NOT NULL REFERENCES chases(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    role            VARCHAR(10) NOT NULL,       -- 'wanted' or 'police'
    
    distance_from_center_m  DOUBLE PRECISION,
    zone_radius_at_time_m   DOUBLE PRECISION,
    overshoot_m             DOUBLE PRECISION,   -- how far outside
    
    -- Consequence
    chase_voided    BOOLEAN DEFAULT FALSE,     -- TRUE if wanted left
    unit_disqualified BOOLEAN DEFAULT FALSE,   -- TRUE if police left
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
    -- Types: 'too_close_at_start', 'no_movement', 'speed_too_low',
    -- 'gps_spoofing', 'same_device_fingerprint', 'repeat_pairing',
    -- 'altitude_impossible', 'insufficient_tracking_points'
    
    details_json    JSONB,
    severity        INT DEFAULT 1,             -- 1-5
    auto_resolved   BOOLEAN DEFAULT FALSE,
    reviewed_by     UUID REFERENCES users(id), -- admin who reviewed
    
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_collusion_user ON collusion_flags(flagged_user_id);

-- ───────────────────────────────────────────
-- VIEWS
-- ───────────────────────────────────────────

-- Active chases with pool info
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

-- Users available for matchmaking near a point
-- Usage: SELECT * FROM find_nearby_users(73.0561, 33.7104, 10000); -- lng, lat, radius_meters
CREATE OR REPLACE FUNCTION find_nearby_users(
    p_lng DOUBLE PRECISION,
    p_lat DOUBLE PRECISION,
    p_radius_m DOUBLE PRECISION
) RETURNS TABLE (
    user_id UUID,
    display_name VARCHAR,
    fcm_token TEXT,
    distance_m DOUBLE PRECISION,
    preferred_role VARCHAR
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        u.id,
        u.display_name,
        u.fcm_token,
        ST_Distance(
            u.location_geom,
            ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
        ) AS distance_m,
        u.preferred_role
    FROM users u
    WHERE u.notify_enabled = TRUE
      AND u.is_banned = FALSE
      AND u.location_geom IS NOT NULL
      AND u.last_location_at > NOW() - INTERVAL '30 minutes'
      AND ST_DWithin(
          u.location_geom,
          ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography,
          p_radius_m
      )
    ORDER BY distance_m;
END;
$$ LANGUAGE plpgsql;

-- Check if a point is within the current chase zone
CREATE OR REPLACE FUNCTION is_within_zone(
    p_chase_id UUID,
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION
) RETURNS BOOLEAN AS $$
DECLARE
    v_center_geom GEOGRAPHY;
    v_radius_m DOUBLE PRECISION;
    v_distance DOUBLE PRECISION;
BEGIN
    SELECT zone_center_geom, current_radius_km * 1000
    INTO v_center_geom, v_radius_m
    FROM chases WHERE id = p_chase_id;
    
    v_distance := ST_Distance(
        v_center_geom,
        ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    );
    
    RETURN v_distance <= v_radius_m;
END;
$$ LANGUAGE plpgsql;

-- 3D distance function (horizontal + vertical)
CREATE OR REPLACE FUNCTION distance_3d(
    lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION, alt1 DOUBLE PRECISION,
    lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION, alt2 DOUBLE PRECISION
) RETURNS TABLE (
    horizontal_m DOUBLE PRECISION,
    vertical_m DOUBLE PRECISION,
    total_m DOUBLE PRECISION
) AS $$
DECLARE
    h_dist DOUBLE PRECISION;
    v_dist DOUBLE PRECISION;
BEGIN
    h_dist := ST_Distance(
        ST_SetSRID(ST_MakePoint(lng1, lat1), 4326)::geography,
        ST_SetSRID(ST_MakePoint(lng2, lat2), 4326)::geography
    );
    v_dist := ABS(COALESCE(alt1, 0) - COALESCE(alt2, 0));
    
    horizontal_m := h_dist;
    vertical_m := v_dist;
    total_m := SQRT(h_dist * h_dist + v_dist * v_dist);
    RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
