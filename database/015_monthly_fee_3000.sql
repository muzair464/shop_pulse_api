-- ============================================================
--  015_monthly_fee_3000.sql
--  Update default monthly fee to 3000
-- ============================================================

ALTER TABLE shops
  ALTER COLUMN subscription_monthly_fee SET DEFAULT 3000;

ALTER TABLE system_subscription_settings
  ALTER COLUMN monthly_fee SET DEFAULT 3000;
