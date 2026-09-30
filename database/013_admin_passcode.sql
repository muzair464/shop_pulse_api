-- ============================================================
--  013_admin_passcode.sql
--  Adds a super-admin passcode to system_subscription_settings.
--  Set your passcode by running:
--    UPDATE system_subscription_settings SET admin_passcode = 'YOUR_SECRET' WHERE id = 1;
-- ============================================================

ALTER TABLE system_subscription_settings
  ADD COLUMN IF NOT EXISTS admin_passcode TEXT NOT NULL DEFAULT '';
