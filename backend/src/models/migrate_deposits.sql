-- Migration: Add deposit_requests table for screenshot-based payment proof
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'deposit_status') THEN
    CREATE TYPE deposit_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS deposit_requests (
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

CREATE INDEX IF NOT EXISTS idx_deposit_requests_user ON deposit_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_requests_status ON deposit_requests(status) WHERE status = 'pending';
