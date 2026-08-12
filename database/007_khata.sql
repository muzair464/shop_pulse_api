-- ============================================================
--  007_khata.sql
--  ShopPulse — Khata (credit ledger) Management System
--
--  New objects:
--    1. customers            — reusable customer profiles per shop
--    2. khata_transactions   — ledger entries (credit given / repayment)
--
--  Changes to existing tables:
--    3. orders.customer_id   — FK → customers (nullable)
--
--  Idempotency strategy:
--    • Tables / indexes / columns  → IF NOT EXISTS  (supported)
--    • CREATE TYPE                 → DO $$ block guard (no IF NOT EXISTS)
--    • CREATE POLICY               → DROP IF EXISTS first, then CREATE
--    • CREATE TRIGGER (notify)     → DROP IF EXISTS first, then CREATE
--    • Functions / views           → CREATE OR REPLACE
--    • trg_khata_balance           → DROP IF EXISTS + CREATE (already done below)
-- ============================================================

-- ────────────────────────────────────────────────────────────────
--  SECTION 1 — customers table
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    UUID          NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name       TEXT          NOT NULL,
  phone      TEXT,
  cnic       TEXT,
  notes      TEXT,
  balance    NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_shop_phone
  ON customers(shop_id, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_shop_id
  ON customers(shop_id);

CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
  ON customers USING gin (name gin_trgm_ops);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

-- Policies: DROP + CREATE is the standard idempotent pattern
-- (CREATE POLICY has no IF NOT EXISTS clause in any Postgres version).
DROP POLICY IF EXISTS "owner manages own customers" ON customers;
CREATE POLICY "owner manages own customers" ON customers
  FOR ALL USING (
    auth.uid() = (SELECT owner_user_id FROM shops WHERE id = shop_id)
  );

-- ────────────────────────────────────────────────────────────────
--  SECTION 2 — khata_tx_type enum
--  CREATE TYPE has no IF NOT EXISTS — use a DO block guard.
-- ────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'khata_tx_type'
  ) THEN
    CREATE TYPE khata_tx_type AS ENUM ('CREDIT', 'REPAYMENT');
  END IF;
END
$$;

-- ────────────────────────────────────────────────────────────────
--  SECTION 3 — khata_transactions table
-- ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS khata_transactions (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id     UUID          NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  order_id    UUID          REFERENCES orders(id) ON DELETE SET NULL,
  tx_type     khata_tx_type NOT NULL,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  notes       TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  voided_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_khata_tx_customer
  ON khata_transactions(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_khata_tx_shop
  ON khata_transactions(shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_khata_tx_order
  ON khata_transactions(order_id)
  WHERE order_id IS NOT NULL;

ALTER TABLE khata_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner manages own khata" ON khata_transactions;
CREATE POLICY "owner manages own khata" ON khata_transactions
  FOR ALL USING (
    auth.uid() = (SELECT owner_user_id FROM shops WHERE id = shop_id)
  );

-- ────────────────────────────────────────────────────────────────
--  SECTION 4 — Link orders → customers
-- ────────────────────────────────────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_customer_id
  ON orders(customer_id)
  WHERE customer_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────
--  SECTION 5 — Balance maintenance trigger
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_customer_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.voided_at IS NULL THEN
      UPDATE customers
         SET balance    = balance + CASE WHEN NEW.tx_type = 'CREDIT'
                                         THEN NEW.amount ELSE -NEW.amount END,
             updated_at = now()
       WHERE id = NEW.customer_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Voiding: reverse the effect of the original entry
    IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
      UPDATE customers
         SET balance    = balance - CASE WHEN NEW.tx_type = 'CREDIT'
                                         THEN NEW.amount ELSE -NEW.amount END,
             updated_at = now()
       WHERE id = NEW.customer_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.voided_at IS NULL THEN
      UPDATE customers
         SET balance    = balance - CASE WHEN OLD.tx_type = 'CREDIT'
                                         THEN OLD.amount ELSE -OLD.amount END,
             updated_at = now()
       WHERE id = OLD.customer_id;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_khata_balance ON khata_transactions;
CREATE TRIGGER trg_khata_balance
  AFTER INSERT OR UPDATE OR DELETE ON khata_transactions
  FOR EACH ROW EXECUTE FUNCTION update_customer_balance();

-- ────────────────────────────────────────────────────────────────
--  SECTION 6 — NOTIFY triggers (DROP + CREATE, no IF NOT EXISTS)
-- ────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_customers_notify    ON customers;
CREATE TRIGGER trg_customers_notify
  AFTER INSERT OR UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION notify_shop_change();

DROP TRIGGER IF EXISTS trg_khata_tx_notify     ON khata_transactions;
CREATE TRIGGER trg_khata_tx_notify
  AFTER INSERT OR UPDATE OR DELETE ON khata_transactions
  FOR EACH ROW EXECUTE FUNCTION notify_shop_change();

-- ────────────────────────────────────────────────────────────────
--  SECTION 7 — customer_khata_summary view
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW customer_khata_summary AS
SELECT
  c.id,
  c.shop_id,
  c.name,
  c.phone,
  c.cnic,
  c.notes,
  c.balance,
  c.created_at,
  c.updated_at,
  (SELECT MAX(kt.created_at)
     FROM khata_transactions kt
    WHERE kt.customer_id = c.id AND kt.voided_at IS NULL
  ) AS last_tx_at,
  (SELECT MAX(kt.created_at)
     FROM khata_transactions kt
    WHERE kt.customer_id = c.id
      AND kt.tx_type = 'REPAYMENT'
      AND kt.voided_at IS NULL
  ) AS last_repayment_at,
  (SELECT COUNT(*)
     FROM khata_transactions kt
    WHERE kt.customer_id = c.id AND kt.voided_at IS NULL
  )::int AS tx_count
FROM customers c;

-- ────────────────────────────────────────────────────────────────
--  END OF MIGRATION 007
-- ────────────────────────────────────────────────────────────────
