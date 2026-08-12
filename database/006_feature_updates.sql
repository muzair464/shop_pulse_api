-- ============================================================
--  006_feature_updates.sql
--  ShopPulse — Additive migration for the following features:
--
--    1. inventory_items.imei2       — optional second IMEI (dual-SIM)
--    2. orders.customer_cnic        — optional customer CNIC field
--    3. order_items.description     — product description snapshot
--    4. checkout_sale()             — updated signature with customer
--                                    fields + description snapshot
--    5. Indexes                     — imei2, customer_cnic, trgm on
--                                    category, composite updated_at
--                                    for delta-sync queries
--    6. get_dashboard_stats()       — replaced by REST route; kept as
--                                    no-op DROP so old callers don't crash
--
--  Safe to run multiple times (all statements are IF NOT EXISTS /
--  OR REPLACE / idempotent).
--
--  Run order: after 005_notify_triggers.sql
-- ============================================================

-- ────────────────────────────────────────────────────────────────
--  SECTION 1 — Column additions
-- ────────────────────────────────────────────────────────────────

-- 1a. inventory_items: second IMEI for dual-SIM devices (USED items)
ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS imei2 TEXT;

-- imei2 is intentionally NOT UNIQUE at the DB level — unlike imei,
-- dual-SIM slot 2 may appear on multiple listings if a device is
-- returned and re-listed.  Application logic can enforce uniqueness
-- when needed.

-- 1b. orders: customer CNIC for identity/warranty tracking
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_cnic TEXT;

-- 1c. order_items: description snapshot at time of sale
--     Allows receipts to show the product description even after
--     the inventory item description is later edited or the item
--     is deleted.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS description TEXT;


-- ────────────────────────────────────────────────────────────────
--  SECTION 2 — Indexes for new columns + query optimisation
-- ────────────────────────────────────────────────────────────────

-- 2a. imei2 equality lookup (same pattern as imei)
CREATE INDEX IF NOT EXISTS idx_inventory_imei2
  ON inventory_items(imei2)
  WHERE imei2 IS NOT NULL;

-- 2b. GIN trgm index on category for POS search
--     (inventory.route.ts searches category ILIKE '%q%')
CREATE INDEX IF NOT EXISTS idx_inventory_category_trgm
  ON inventory_items USING gin (category gin_trgm_ops);

-- 2c. Composite index for delta-sync queries
--     (GET /api/v1/inventory?updatedAfter=... filters on shop_id + updated_at)
CREATE INDEX IF NOT EXISTS idx_inventory_shop_updated
  ON inventory_items(shop_id, updated_at DESC);

-- 2d. Dashboard stats — orders by shop + created_at (already covered by
--     idx_orders_shop_created but adding a covering index for total/subtotal
--     so the KPI aggregation is index-only on small result sets)
CREATE INDEX IF NOT EXISTS idx_orders_shop_created_total
  ON orders(shop_id, created_at DESC)
  INCLUDE (total, subtotal, discount, payment_method);

-- 2e. customer_cnic lookup (optional — for future customer history feature)
CREATE INDEX IF NOT EXISTS idx_orders_customer_cnic
  ON orders(shop_id, customer_cnic)
  WHERE customer_cnic IS NOT NULL;

-- 2f. Top-products query: order_items joined to orders on shop_id
--     (covers the GROUP BY name_snapshot aggregation in the dashboard)
CREATE INDEX IF NOT EXISTS idx_order_items_order_created
  ON order_items(order_id);
-- (idx_order_items_order_id already exists from 002; this is a no-op guard)


-- ────────────────────────────────────────────────────────────────
--  SECTION 3 — Updated checkout_sale() function
--  Adds: customer_name, customer_phone, customer_cnic fields on
--  the order row, and description snapshot on each order_item line.
-- ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION checkout_sale(
  p_shop_id          UUID,
  p_items            JSONB,
  -- [{inventoryId, qty, unitPrice, nameSnapshot, description?}]
  p_discount         NUMERIC,
  p_payment_method   TEXT,
  p_idempotency_key  TEXT,
  p_customer_name    TEXT    DEFAULT NULL,
  p_customer_phone   TEXT    DEFAULT NULL,
  p_customer_cnic    TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item            JSONB;
  v_order_id        UUID;
  v_subtotal        NUMERIC := 0;
  v_rows_affected   INT;
BEGIN
  -- ── Idempotency check ──────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM orders WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN (
      SELECT to_jsonb(o)
      FROM   orders o
      WHERE  idempotency_key = p_idempotency_key
    );
  END IF;

  -- ── Stock decrement ────────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE inventory_items
       SET stock   = stock - (v_item->>'qty')::INT,
           version = version + 1
     WHERE id      = (v_item->>'inventoryId')::UUID
       AND shop_id = p_shop_id
       AND stock  >= (v_item->>'qty')::INT;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    IF v_rows_affected = 0 THEN
      RAISE EXCEPTION 'Insufficient stock for item %',
        v_item->>'inventoryId'
        USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal
                  + (v_item->>'qty')::INT
                  * (v_item->>'unitPrice')::NUMERIC;
  END LOOP;

  -- ── Insert order ───────────────────────────────────────────
  INSERT INTO orders (
    shop_id, order_number, channel, payment_method,
    subtotal, discount, total, payment_verified, idempotency_key,
    customer_name, customer_phone, customer_cnic
  )
  VALUES (
    p_shop_id,
    'SP-' || to_char(nextval('order_number_seq'), 'FM0000'),
    'POS',
    p_payment_method::payment_method,
    v_subtotal,
    p_discount,
    v_subtotal - p_discount,
    p_payment_method != 'DIGITAL_PAY',
    p_idempotency_key,
    p_customer_name,
    p_customer_phone,
    p_customer_cnic
  )
  RETURNING id INTO v_order_id;

  -- ── Insert order lines ─────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO order_items (
      order_id, inventory_item_id, name_snapshot, description,
      qty, unit_price, line_total
    )
    VALUES (
      v_order_id,
      (v_item->>'inventoryId')::UUID,
      v_item->>'nameSnapshot',
      v_item->>'description',           -- may be NULL for items with no description
      (v_item->>'qty')::INT,
      (v_item->>'unitPrice')::NUMERIC,
      (v_item->>'qty')::INT * (v_item->>'unitPrice')::NUMERIC
    );
  END LOOP;

  RETURN (SELECT to_jsonb(o) FROM orders o WHERE id = v_order_id);
END;
$$;


-- ────────────────────────────────────────────────────────────────
--  SECTION 4 — Drop legacy RPC functions no longer called by the
--  frontend (dashboard queries now go through the REST route;
--  keeping empty shells avoids breaking any tooling that references
--  the function names).
-- ────────────────────────────────────────────────────────────────

-- get_dashboard_stats is superseded by GET /api/v1/dashboard/stats.
-- Drop and recreate as a trivial stub so any existing grants / Supabase
-- RPC configs don't error on startup.
CREATE OR REPLACE FUNCTION get_dashboard_stats(p_shop_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT '{}'::JSONB;
$$;

-- get_revenue_chart_data is likewise superseded.
CREATE OR REPLACE FUNCTION get_revenue_chart_data(
  p_shop_id UUID,
  p_days    INT DEFAULT 30
)
RETURNS TABLE (
  day           DATE,
  total_revenue NUMERIC,
  order_count   BIGINT
)
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT NULL::DATE, NULL::NUMERIC, NULL::BIGINT WHERE false;
$$;


-- ────────────────────────────────────────────────────────────────
--  SECTION 5 — RLS: no new tables, existing policies unchanged.
--  The new columns (imei2, customer_cnic, description) are covered
--  by the existing table-level policies on inventory_items, orders,
--  and order_items respectively — no additional policies needed.
-- ────────────────────────────────────────────────────────────────

-- Nothing to add.


-- ────────────────────────────────────────────────────────────────
--  SECTION 6 — NOTIFY trigger: refresh to pick up imei2 changes.
--  The trigger body itself is unchanged; OR REPLACE ensures the
--  definition stays current if the function was patched locally.
-- ────────────────────────────────────────────────────────────────

-- Re-apply notify function (idempotent — no logic change, just
-- ensures the version on this Supabase project is authoritative).
CREATE OR REPLACE FUNCTION notify_shop_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'inventory_items' THEN v_shop_id := COALESCE(NEW.shop_id, OLD.shop_id);
    WHEN 'orders'          THEN v_shop_id := COALESCE(NEW.shop_id, OLD.shop_id);
    WHEN 'shops'           THEN v_shop_id := COALESCE(NEW.id,      OLD.id);
    ELSE                        v_shop_id := NULL;
  END CASE;

  PERFORM pg_notify(
    'shop_changes',
    jsonb_build_object(
      'shop_id', v_shop_id,
      'table',   TG_TABLE_NAME,
      'op',      TG_OP,
      'id',      COALESCE(NEW.id, OLD.id)
    )::text
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Triggers are already created in 005; nothing new to add.
-- (DROP + CREATE is intentionally avoided here to prevent
--  a brief window where the trigger doesn't exist on a live DB.)


-- ────────────────────────────────────────────────────────────────
--  END OF MIGRATION 006
-- ────────────────────────────────────────────────────────────────
