-- ============================================================
--  011_shop_stats_performance.sql
--  Performance optimization: incremental shop-level aggregates
--
--  Problem: Dashboard endpoint computes all-time totals via full
--  table scans + multi-table joins on every request, growing
--  linearly with order history (orders ⋈ order_items ⋈ inventory_items).
--
--  Solution: Maintain pre-aggregated counters in shop_stats,
--  updated incrementally via triggers. Dashboard queries become
--  single-row lookups instead of full scans.
-- ============================================================

-- ── shop_stats table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_stats (
  shop_id               UUID PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  
  -- Order aggregates (all-time)
  total_orders          BIGINT  NOT NULL DEFAULT 0,
  total_sales           NUMERIC NOT NULL DEFAULT 0,
  total_profit          NUMERIC NOT NULL DEFAULT 0,
  
  -- Customer aggregates
  total_customers       INT     NOT NULL DEFAULT 0,  -- distinct customer_phone count
  repeat_customers      INT     NOT NULL DEFAULT 0,  -- phones with >1 order
  
  -- Inventory aggregates
  total_inventory_items INT     NOT NULL DEFAULT 0,
  out_of_stock_count    INT     NOT NULL DEFAULT 0,
  low_stock_count       INT     NOT NULL DEFAULT 0,  -- stock > 0 AND stock <= 5
  
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE shop_stats IS 'Incrementally-maintained shop-level aggregates for dashboard performance';

CREATE INDEX idx_shop_stats_updated ON shop_stats(updated_at);

-- ── Backfill existing shops ──────────────────────────────────────
INSERT INTO shop_stats (
  shop_id, total_orders, total_sales, total_profit,
  total_customers, repeat_customers,
  total_inventory_items, out_of_stock_count, low_stock_count
)
SELECT
  s.id AS shop_id,
  
  -- Order stats
  COALESCE((SELECT COUNT(*) FROM orders WHERE shop_id = s.id), 0)::bigint,
  COALESCE((SELECT SUM(total) FROM orders WHERE shop_id = s.id), 0)::numeric,
  COALESCE((
    SELECT SUM(oi.qty * oi.unit_price) - SUM(oi.qty * COALESCE(ii.cost_price, 0))
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN inventory_items ii ON ii.id = oi.inventory_item_id
    WHERE o.shop_id = s.id
  ), 0)::numeric,
  
  -- Customer stats
  COALESCE((
    SELECT COUNT(DISTINCT customer_phone)
    FROM orders
    WHERE shop_id = s.id AND customer_phone IS NOT NULL
  ), 0)::int,
  COALESCE((
    SELECT COUNT(*) FROM (
      SELECT customer_phone
      FROM orders
      WHERE shop_id = s.id AND customer_phone IS NOT NULL
      GROUP BY customer_phone
      HAVING COUNT(*) > 1
    ) rc
  ), 0)::int,
  
  -- Inventory stats
  COALESCE((SELECT COUNT(*) FROM inventory_items WHERE shop_id = s.id), 0)::int,
  COALESCE((SELECT COUNT(*) FROM inventory_items WHERE shop_id = s.id AND stock = 0), 0)::int,
  COALESCE((SELECT COUNT(*) FROM inventory_items WHERE shop_id = s.id AND stock > 0 AND stock <= 5), 0)::int

FROM shops s
ON CONFLICT (shop_id) DO NOTHING;

-- ── Trigger functions ────────────────────────────────────────────

-- Update shop_stats when orders are inserted
CREATE OR REPLACE FUNCTION update_shop_stats_on_order_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_profit NUMERIC;
  v_is_new_customer BOOLEAN;
  v_customer_order_count INT;
BEGIN
  -- Calculate profit for this order
  SELECT COALESCE(
    SUM(oi.qty * oi.unit_price) - SUM(oi.qty * COALESCE(ii.cost_price, 0)),
    0
  )
  INTO v_profit
  FROM order_items oi
  LEFT JOIN inventory_items ii ON ii.id = oi.inventory_item_id
  WHERE oi.order_id = NEW.id;
  
  -- Check if this is a new customer (phone-based)
  IF NEW.customer_phone IS NOT NULL THEN
    SELECT COUNT(*) INTO v_customer_order_count
    FROM orders
    WHERE shop_id = NEW.shop_id
      AND customer_phone = NEW.customer_phone;
    
    v_is_new_customer := (v_customer_order_count = 1);
  ELSE
    v_is_new_customer := FALSE;
    v_customer_order_count := 0;
  END IF;
  
  -- Update shop_stats
  INSERT INTO shop_stats (
    shop_id, total_orders, total_sales, total_profit,
    total_customers, repeat_customers
  )
  VALUES (
    NEW.shop_id, 1, NEW.total, v_profit,
    CASE WHEN v_is_new_customer THEN 1 ELSE 0 END,
    CASE WHEN v_customer_order_count = 2 THEN 1 ELSE 0 END
  )
  ON CONFLICT (shop_id) DO UPDATE SET
    total_orders = shop_stats.total_orders + 1,
    total_sales = shop_stats.total_sales + NEW.total,
    total_profit = shop_stats.total_profit + v_profit,
    total_customers = shop_stats.total_customers + 
      CASE WHEN v_is_new_customer THEN 1 ELSE 0 END,
    repeat_customers = shop_stats.repeat_customers +
      CASE WHEN v_customer_order_count = 2 THEN 1 ELSE 0 END,
    updated_at = now();
  
  RETURN NEW;
END;
$$;

-- Update shop_stats when inventory changes
CREATE OR REPLACE FUNCTION update_shop_stats_on_inventory_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_old_out_of_stock BOOLEAN;
  v_new_out_of_stock BOOLEAN;
  v_old_low_stock BOOLEAN;
  v_new_low_stock BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- New item added
    INSERT INTO shop_stats (
      shop_id, total_inventory_items,
      out_of_stock_count, low_stock_count
    )
    VALUES (
      NEW.shop_id, 1,
      CASE WHEN NEW.stock = 0 THEN 1 ELSE 0 END,
      CASE WHEN NEW.stock > 0 AND NEW.stock <= 5 THEN 1 ELSE 0 END
    )
    ON CONFLICT (shop_id) DO UPDATE SET
      total_inventory_items = shop_stats.total_inventory_items + 1,
      out_of_stock_count = shop_stats.out_of_stock_count +
        CASE WHEN NEW.stock = 0 THEN 1 ELSE 0 END,
      low_stock_count = shop_stats.low_stock_count +
        CASE WHEN NEW.stock > 0 AND NEW.stock <= 5 THEN 1 ELSE 0 END,
      updated_at = now();
    
  ELSIF TG_OP = 'UPDATE' THEN
    -- Stock level changed
    v_old_out_of_stock := (OLD.stock = 0);
    v_new_out_of_stock := (NEW.stock = 0);
    v_old_low_stock := (OLD.stock > 0 AND OLD.stock <= 5);
    v_new_low_stock := (NEW.stock > 0 AND NEW.stock <= 5);
    
    UPDATE shop_stats SET
      out_of_stock_count = out_of_stock_count +
        CASE WHEN v_new_out_of_stock AND NOT v_old_out_of_stock THEN 1
             WHEN NOT v_new_out_of_stock AND v_old_out_of_stock THEN -1
             ELSE 0 END,
      low_stock_count = low_stock_count +
        CASE WHEN v_new_low_stock AND NOT v_old_low_stock THEN 1
             WHEN NOT v_new_low_stock AND v_old_low_stock THEN -1
             ELSE 0 END,
      updated_at = now()
    WHERE shop_id = NEW.shop_id;
    
  ELSIF TG_OP = 'DELETE' THEN
    -- Item removed
    UPDATE shop_stats SET
      total_inventory_items = total_inventory_items - 1,
      out_of_stock_count = out_of_stock_count -
        CASE WHEN OLD.stock = 0 THEN 1 ELSE 0 END,
      low_stock_count = low_stock_count -
        CASE WHEN OLD.stock > 0 AND OLD.stock <= 5 THEN 1 ELSE 0 END,
      updated_at = now()
    WHERE shop_id = OLD.shop_id;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ── Create triggers ──────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_shop_stats_order_insert ON orders;
CREATE TRIGGER trg_shop_stats_order_insert
  AFTER INSERT ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_shop_stats_on_order_insert();

DROP TRIGGER IF EXISTS trg_shop_stats_inventory_change ON inventory_items;
CREATE TRIGGER trg_shop_stats_inventory_change
  AFTER INSERT OR UPDATE OR DELETE ON inventory_items
  FOR EACH ROW
  EXECUTE FUNCTION update_shop_stats_on_inventory_change();

-- ── Additional indexes for better performance ────────────────────
-- Repeat customer calculation (if kept query-time anywhere)
CREATE INDEX IF NOT EXISTS idx_orders_shop_customer_phone
  ON orders(shop_id, customer_phone)
  WHERE customer_phone IS NOT NULL;

-- Customer search optimization
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm
  ON customers USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_customers_phone_trgm
  ON customers USING gin (phone gin_trgm_ops);

