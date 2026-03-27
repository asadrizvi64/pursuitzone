-- ═══════════════════════════════════════════════════════════════
-- PURSUIT ZONE — Production Database Optimization
-- Table partitioning, performance indexes, connection tuning
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────
-- 1. GPS TRACKS TABLE PARTITIONING
-- At scale: millions of rows/day. Monthly partitions
-- with automated creation via pg_partman
-- ────────────────────────────────────────────────

-- Convert gps_tracks to partitioned table
-- (Run ONCE on fresh setup — migrate existing data first if needed)
CREATE TABLE IF NOT EXISTS gps_tracks_partitioned (
    id              BIGSERIAL,
    chase_id        UUID NOT NULL,
    user_id         UUID NOT NULL,
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    altitude        DOUBLE PRECISION,
    accuracy        DOUBLE PRECISION,
    speed           DOUBLE PRECISION,
    heading         DOUBLE PRECISION,
    altitude_source VARCHAR(20),
    is_mock_location BOOLEAN DEFAULT FALSE,
    geom            GEOGRAPHY(Point, 4326),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, recorded_at)
) PARTITION BY RANGE (recorded_at);

-- Create partitions for next 6 months
DO $$
DECLARE
    start_date DATE := DATE_TRUNC('month', CURRENT_DATE);
    partition_name TEXT;
    partition_start DATE;
    partition_end DATE;
BEGIN
    FOR i IN 0..5 LOOP
        partition_start := start_date + (i || ' months')::INTERVAL;
        partition_end := start_date + ((i + 1) || ' months')::INTERVAL;
        partition_name := 'gps_tracks_' || TO_CHAR(partition_start, 'YYYY_MM');
        
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF gps_tracks_partitioned
             FOR VALUES FROM (%L) TO (%L)',
            partition_name, partition_start, partition_end
        );
        
        -- Create indexes on each partition
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (chase_id, user_id, recorded_at DESC)',
            partition_name || '_chase_user_idx', partition_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I USING GIST (geom)',
            partition_name || '_geom_idx', partition_name
        );
    END LOOP;
END $$;

-- Auto-create partitions script (run monthly via cron)
-- SELECT create_next_partition();
CREATE OR REPLACE FUNCTION create_next_partition()
RETURNS void AS $$
DECLARE
    next_month DATE := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '1 month');
    end_month DATE := next_month + INTERVAL '1 month';
    part_name TEXT := 'gps_tracks_' || TO_CHAR(next_month, 'YYYY_MM');
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF gps_tracks_partitioned
         FOR VALUES FROM (%L) TO (%L)',
        part_name, next_month, end_month
    );
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I (chase_id, user_id, recorded_at DESC)',
        part_name || '_chase_user_idx', part_name
    );
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON %I USING GIST (geom)',
        part_name || '_geom_idx', part_name
    );
    RAISE NOTICE 'Created partition: %', part_name;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────
-- 2. PERFORMANCE INDEXES
-- ────────────────────────────────────────────────

-- Active chases — most frequently queried
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chases_active_status
    ON chases(status, zone_center_geom)
    WHERE status IN ('matchmaking', 'countdown', 'heat', 'cooldown');

-- Chase participants — fast lookups during chase
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_participants_active
    ON chase_participants(chase_id, status)
    WHERE status IN ('queued', 'active');

-- Transactions — user wallet history
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_txn_user_recent
    ON transactions(user_id, created_at DESC);

-- Notifications — unread per user
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notif_unread
    ON notifications(user_id, created_at DESC)
    WHERE read_at IS NULL;

-- Users — nearby matching for matchmaking
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_active_location
    ON users USING GIST(location_geom)
    WHERE notify_enabled = TRUE AND is_banned = FALSE
      AND last_location_at > NOW() - INTERVAL '30 minutes';

-- Collusion flags — lookup by user
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_collusion_user_recent
    ON collusion_flags(flagged_user_id, created_at DESC);

-- ────────────────────────────────────────────────
-- 3. CONNECTION POOLING — PgBouncer Config
-- ────────────────────────────────────────────────

-- PostgreSQL server-side tuning (set via RDS parameter group)
-- max_connections = 500
-- shared_buffers = 8GB          (25% of 32GB RAM)
-- effective_cache_size = 24GB   (75% of RAM)
-- work_mem = 256MB              (for PostGIS spatial queries)
-- maintenance_work_mem = 1GB
-- random_page_cost = 1.1        (SSD)
-- checkpoint_completion_target = 0.9
-- wal_buffers = 64MB
-- default_statistics_target = 200
-- max_parallel_workers_per_gather = 4
-- max_parallel_workers = 8

-- PgBouncer pool settings:
-- pool_mode = transaction        (critical for Node.js with async queries)
-- max_client_conn = 2000         (across all API pods)
-- default_pool_size = 50         (per database)
-- reserve_pool_size = 10
-- reserve_pool_timeout = 3
-- server_idle_timeout = 300
-- query_wait_timeout = 120
-- client_idle_timeout = 0        (let app manage idle)

-- ────────────────────────────────────────────────
-- 4. MATERIALIZED VIEW — Chase leaderboard (refresh every 5 min)
-- ────────────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_leaderboard AS
SELECT
    u.id,
    u.display_name,
    u.wanted_escapes + u.police_captures AS total_wins,
    u.wanted_earnings + u.police_earnings AS total_earnings,
    u.wanted_rating,
    u.police_rating,
    RANK() OVER (ORDER BY (u.wanted_earnings + u.police_earnings) DESC) AS rank
FROM users u
WHERE (u.wanted_escapes + u.police_captures) > 0
ORDER BY total_earnings DESC
LIMIT 1000;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_leaderboard_id ON mv_leaderboard(id);

-- Refresh function (call via pg_cron or app cron)
CREATE OR REPLACE FUNCTION refresh_leaderboard()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_leaderboard;
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────
-- 5. CLEANUP — Archive old data
-- ────────────────────────────────────────────────

-- Archive completed chases older than 90 days
-- (In production: export to S3 via aws_s3 extension, then delete)
CREATE OR REPLACE FUNCTION cleanup_old_data()
RETURNS void AS $$
BEGIN
    -- Delete old GPS tracks (handled by partition drop)
    -- DROP old partitions: DROP TABLE gps_tracks_2025_01;
    
    -- Archive old notifications
    DELETE FROM notifications 
    WHERE created_at < NOW() - INTERVAL '90 days' 
      AND read_at IS NOT NULL;
    
    -- Archive old transactions (keep summary, delete line items)
    DELETE FROM transactions
    WHERE created_at < NOW() - INTERVAL '365 days';
    
    -- Clean collusion flags
    DELETE FROM collusion_flags
    WHERE created_at < NOW() - INTERVAL '180 days'
      AND auto_resolved = TRUE;
    
    RAISE NOTICE 'Cleanup complete';
END;
$$ LANGUAGE plpgsql;
