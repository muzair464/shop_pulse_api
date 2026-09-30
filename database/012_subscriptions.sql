-- ============================================================
--  012_subscriptions.sql
--  ShopPulse — Monthly Subscription & Manual Payment Verification
--  (Bank / Easypaisa payment verification system)
-- ============================================================

-- 1. Subscription status & payment status enums
DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('active', 'expired', 'pending_verification', 'trial');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_request_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Alter shops table with subscription fields and system payment account info
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS subscription_status subscription_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  ADD COLUMN IF NOT EXISTS subscription_monthly_fee NUMERIC NOT NULL DEFAULT 2000;

-- 3. System payment settings (singleton row where admin sets EasyPaisa / Bank Account & QR)
CREATE TABLE IF NOT EXISTS system_subscription_settings (
  id                        INT PRIMARY KEY DEFAULT 1,
  monthly_fee               NUMERIC NOT NULL DEFAULT 2000,
  bank_name                 TEXT NOT NULL DEFAULT '',
  account_title             TEXT NOT NULL DEFAULT '',
  account_number            TEXT NOT NULL DEFAULT '',
  iban                      TEXT NOT NULL DEFAULT '',
  easypaisa_title           TEXT NOT NULL DEFAULT '',
  easypaisa_number          TEXT NOT NULL DEFAULT '',
  payment_qr_bytes          BYTEA,
  payment_qr_mime_type      TEXT,
  instructions              TEXT NOT NULL DEFAULT 'Transfer the monthly fee to Easypaisa or Bank Account, then submit the Transaction ID (TRX ID) and payment screenshot below. Your account will be activated once verified.',
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row_check CHECK (id = 1)
);

-- Seed default settings row if missing
INSERT INTO system_subscription_settings (id, monthly_fee)
VALUES (1, 2000)
ON CONFLICT (id) DO NOTHING;

-- 4. Subscription payment requests submitted by shop owners
CREATE TABLE IF NOT EXISTS subscription_payments (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                   UUID NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  amount                    NUMERIC NOT NULL,
  payment_method            TEXT NOT NULL, -- 'EASYPAISA' or 'BANK'
  transaction_id            TEXT NOT NULL,
  sender_account            TEXT,
  receipt_bytes             BYTEA,
  receipt_mime_type         TEXT,
  notes                     TEXT,
  status                    payment_request_status NOT NULL DEFAULT 'pending',
  admin_notes               TEXT,
  verified_at               TIMESTAMPTZ,
  verified_by               UUID,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_shop_id ON subscription_payments(shop_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status ON subscription_payments(status);

-- 5. Enable RLS
ALTER TABLE system_subscription_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_payments ENABLE ROW LEVEL SECURITY;

-- system_subscription_settings: Any authenticated user can read payment details
CREATE POLICY "anyone_auth_read_system_settings"
  ON system_subscription_settings
  FOR SELECT
  USING (true);

-- subscription_payments: Shop owners can read and insert their own payments
CREATE POLICY "owner_read_own_subscription_payments"
  ON subscription_payments
  FOR SELECT
  USING (
    auth.uid() = (
      SELECT owner_user_id FROM shops WHERE id = shop_id
    )
  );

CREATE POLICY "owner_insert_own_subscription_payments"
  ON subscription_payments
  FOR INSERT
  WITH CHECK (
    auth.uid() = (
      SELECT owner_user_id FROM shops WHERE id = shop_id
    )
  );

-- 6. Helper function to approve a subscription payment
-- Extends the shop subscription by 30 days and marks payment approved
CREATE OR REPLACE FUNCTION approve_subscription_payment(
  p_payment_id UUID,
  p_admin_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_payment subscription_payments%ROWTYPE;
  v_current_expiry TIMESTAMPTZ;
  v_new_expiry TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_payment FROM subscription_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment request % not found', p_payment_id;
  END IF;

  IF v_payment.status = 'approved' THEN
    RAISE EXCEPTION 'Payment request % is already approved', p_payment_id;
  END IF;

  SELECT subscription_expires_at INTO v_current_expiry FROM shops WHERE id = v_payment.shop_id FOR UPDATE;

  -- If already expired, start 30 days from now. If active, extend from existing expiry date.
  IF v_current_expiry IS NULL OR v_current_expiry < now() THEN
    v_new_expiry := now() + INTERVAL '30 days';
  ELSE
    v_new_expiry := v_current_expiry + INTERVAL '30 days';
  END IF;

  UPDATE shops
  SET subscription_status = 'active',
      subscription_expires_at = v_new_expiry,
      updated_at = now()
  WHERE id = v_payment.shop_id;

  UPDATE subscription_payments
  SET status = 'approved',
      admin_notes = p_admin_notes,
      verified_at = now(),
      updated_at = now()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'payment_id', p_payment_id,
    'shop_id', v_payment.shop_id,
    'status', 'approved',
    'subscription_expires_at', v_new_expiry
  );
END;
$$;
