-- ============================================================
--  003_rls.sql
--  ShopPulse — Row Level Security policies
--  Run order: 3 of 4  (after 002_indexes.sql)
--
--  Every table has RLS ENABLED.  The anon key is shipped to every
--  browser, so a misconfigured (or missing) policy is equivalent
--  to a public database.  Policy tests (cross-shop read/write with
--  a different auth.uid()) should be part of the test suite.
-- ============================================================

-- ── shops ─────────────────────────────────────────────────────
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;

-- The owner can read and write their own shop row only.
CREATE POLICY "owner_all_on_own_shop"
  ON shops
  FOR ALL
  USING      (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- ── devices ───────────────────────────────────────────────────
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_on_own_devices"
  ON devices
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── inventory_items ───────────────────────────────────────────
ALTER TABLE inventory_items ENABLE ROW LEVEL SECURITY;

-- Sub-select resolves the owning shop then checks auth.uid().
-- Wrapped in a SECURITY DEFINER view would be marginally faster,
-- but the sub-select is clear and correct for this data volume.
CREATE POLICY "owner_all_on_own_inventory"
  ON inventory_items
  FOR ALL
  USING (
    auth.uid() = (
      SELECT owner_user_id FROM shops WHERE id = shop_id
    )
  )
  WITH CHECK (
    auth.uid() = (
      SELECT owner_user_id FROM shops WHERE id = shop_id
    )
  );

-- ── orders ────────────────────────────────────────────────────
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_all_on_own_orders"
  ON orders
  FOR ALL
  USING (
    auth.uid() = (
      SELECT owner_user_id FROM shops WHERE id = shop_id
    )
  )
  WITH CHECK (
    auth.uid() = (
      SELECT owner_user_id FROM shops WHERE id = shop_id
    )
  );

-- ── order_items ───────────────────────────────────────────────
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Two-level join: order_items → orders → shops → owner_user_id.
CREATE POLICY "owner_all_on_own_order_items"
  ON order_items
  FOR ALL
  USING (
    auth.uid() = (
      SELECT s.owner_user_id
      FROM shops s
      JOIN orders o ON o.shop_id = s.id
      WHERE o.id = order_id
    )
  )
  WITH CHECK (
    auth.uid() = (
      SELECT s.owner_user_id
      FROM shops s
      JOIN orders o ON o.shop_id = s.id
      WHERE o.id = order_id
    )
  );

-- ── Realtime publication ──────────────────────────────────────
-- Allow Supabase Realtime to publish changes for these tables.
-- RLS policies above still apply — each subscriber only receives
-- rows that pass their own auth.uid() check.
ALTER PUBLICATION supabase_realtime ADD TABLE inventory_items;
ALTER PUBLICATION supabase_realtime ADD TABLE orders;
ALTER PUBLICATION supabase_realtime ADD TABLE devices;
