-- ============================================================
--  001_schema.sql
--  ShopPulse — Core table definitions + sequences + types
--  Run order: 1 of 4
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
-- pg_trgm powers the GIN index for fuzzy name/category search
-- in the POS catalog pane (SearchInput).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Sequences ────────────────────────────────────────────────
-- Human-readable order numbers like "SP-0042".
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;

-- ── Enum types ───────────────────────────────────────────────
CREATE TYPE item_classification AS ENUM ('NEW', 'USED');
CREATE TYPE order_channel        AS ENUM ('POS', 'ONLINE');
CREATE TYPE payment_method       AS ENUM ('CASH', 'CARD_KHATA', 'DIGITAL_PAY');

-- ── shops ─────────────────────────────────────────────────────
-- One shop per owner (auth.users row).  The UNIQUE constraint on
-- owner_user_id is what enforces the 1:1 relationship — an owner
-- can never accidentally create a second shop.
CREATE TABLE shops (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id         UUID        UNIQUE NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name                  TEXT        NOT NULL,
  phone                 TEXT,
  address               TEXT,
  -- Digital Pay QR image stored as raw bytes — no object storage needed.
  payment_qr_bytes      BYTEA,
  payment_qr_mime_type  TEXT,
  -- Export / hardware preferences
  auto_export_frequency TEXT        NOT NULL DEFAULT 'weekly',
  auto_print_receipt    BOOLEAN     NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── devices ───────────────────────────────────────────────────
-- Human-readable device labels linked to Supabase Auth sessions.
-- revoked_at is set when the owner revokes a device from Settings;
-- Supabase Admin API invalidates the actual session token.
CREATE TABLE devices (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id     UUID,                       -- matches auth.sessions.id
  device_name    TEXT,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);

-- ── inventory_items ───────────────────────────────────────────
-- Covers both NEW (bulk stock tracked by qty) and USED (serialized,
-- tracked individually by IMEI).  stock >= 0 enforced at DB level
-- as an extra guard beyond the checkout_sale conditional UPDATE.
CREATE TABLE inventory_items (
  id             UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id        UUID                NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  classification item_classification NOT NULL,
  name           TEXT                NOT NULL,
  description    TEXT,
  category       TEXT                NOT NULL,
  imei           TEXT                UNIQUE,    -- USED items only; NULL for NEW
  sku            TEXT,
  stock          INTEGER             NOT NULL DEFAULT 0 CHECK (stock >= 0),
  cost_price     NUMERIC(12,2)       NOT NULL,
  selling_price  NUMERIC(12,2)       NOT NULL,
  -- Optimistic concurrency: Angular sends back the version it read;
  -- a stale value is rejected (WHERE version = $expected).
  version        INTEGER             NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ         NOT NULL DEFAULT now()
);

-- ── orders ────────────────────────────────────────────────────
-- Created only through checkout_sale() to guarantee atomicity.
-- idempotency_key prevents duplicate orders on network retry.
-- payment_verified = false only for DIGITAL_PAY (manual reconciliation).
CREATE TABLE orders (
  id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          UUID           NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  order_number     TEXT           UNIQUE NOT NULL,   -- e.g. "SP-0042"
  customer_name    TEXT,
  customer_phone   TEXT,
  channel          order_channel  NOT NULL DEFAULT 'POS',
  payment_method   payment_method NOT NULL,
  subtotal         NUMERIC(12,2)  NOT NULL,
  discount         NUMERIC(12,2)  NOT NULL DEFAULT 0,
  total            NUMERIC(12,2)  NOT NULL,
  payment_verified BOOLEAN        NOT NULL DEFAULT true,
  idempotency_key  TEXT           UNIQUE,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ── order_items ───────────────────────────────────────────────
-- inventory_item_id is nullable so historical order lines survive
-- even if the inventory item is later deleted.
-- name_snapshot captures the product name at time of sale.
CREATE TABLE order_items (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  inventory_item_id UUID          REFERENCES inventory_items(id) ON DELETE SET NULL,
  name_snapshot     TEXT          NOT NULL,
  qty               INTEGER       NOT NULL CHECK (qty > 0),
  unit_price        NUMERIC(12,2) NOT NULL,
  line_total        NUMERIC(12,2) NOT NULL
);

-- ── updated_at trigger function ───────────────────────────────
-- Keeps updated_at current automatically on any UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_shops_updated_at
  BEFORE UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_inventory_items_updated_at
  BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
