-- ============================================================
--  014_new_shop_expired.sql
--  New shops should start as 'expired' (unpaid), not 'active'.
--  Admin must approve payment before shop gets access.
-- ============================================================

-- Change default subscription_status from 'active' to 'expired'
ALTER TABLE shops
  ALTER COLUMN subscription_status SET DEFAULT 'expired',
  ALTER COLUMN subscription_expires_at SET DEFAULT now();

-- Existing shops already created with 'active' / future expiry are unaffected.
