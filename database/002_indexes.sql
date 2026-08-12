-- ============================================================
--  002_indexes.sql
--  ShopPulse — Performance indexes
--  Run order: 2 of 4  (after 001_schema.sql)
-- ============================================================

-- ── inventory_items ───────────────────────────────────────────

-- Primary access pattern: list all items for a shop filtered by category.
CREATE INDEX idx_inventory_shop_category
  ON inventory_items(shop_id, category);

-- POS catalog fuzzy search — matches "iphone", "iPhon", "phn" etc.
-- Requires pg_trgm extension (enabled in 001_schema.sql).
CREATE INDEX idx_inventory_name_trgm
  ON inventory_items USING gin (name gin_trgm_ops);

-- IMEI lookup for used-device sales (equality, not fuzzy).
CREATE INDEX idx_inventory_imei
  ON inventory_items(imei)
  WHERE imei IS NOT NULL;

-- Low-stock webhook trigger pattern: stock <= threshold.
CREATE INDEX idx_inventory_stock
  ON inventory_items(shop_id, stock);

-- ── orders ────────────────────────────────────────────────────

-- Orders list page: most-recent-first per shop.
CREATE INDEX idx_orders_shop_created
  ON orders(shop_id, created_at DESC);

-- Idempotency key lookup on checkout retry.
CREATE INDEX idx_orders_idempotency
  ON orders(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── order_items ───────────────────────────────────────────────

-- Join from order → its lines.
CREATE INDEX idx_order_items_order_id
  ON order_items(order_id);

-- ── devices ──────────────────────────────────────────────────

-- Active-devices list for a user.
CREATE INDEX idx_devices_user_id
  ON devices(user_id)
  WHERE revoked_at IS NULL;
