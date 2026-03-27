-- Additional tables for auth and wallet features

-- OTP codes for phone verification
CREATE TABLE IF NOT EXISTS otp_codes (
    phone       VARCHAR(20) PRIMARY KEY,
    code        VARCHAR(6) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Add Stripe customer ID to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);

-- Create index for faster auth lookups
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

-- Cleanup expired OTPs (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_otps() RETURNS void AS $$
BEGIN
    DELETE FROM otp_codes WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;
