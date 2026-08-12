-- ============================================================
--  004_functions.sql
--  ShopPulse — Stored procedures & helper functions
--  Run order: 4 of 4  (after 003_rls.sql)
-- ============================================================

-- ── checkout_sale ─────────────────────────────────────────────
-- Called from the Node.js /api/v1/pos/checkout Vercel Function
-- using the SERVICE-ROLE client (supabase.rpc).
--
-- This is the ONLY correct place for the overselling guard.
-- Independent Vercel serverless instances have no shared memory;
-- only a Postgres transaction can atomically decrement stock and
-- insert the order — preventing two simultaneous checkouts from
-- both seeing stock = 1 and both succeeding.
--
-- SECURITY DEFINER: runs as the function owner (superuser), not
-- the calling role.  p_shop_id is passed explicitly because
-- auth.uid() has no meaning under a service-role connection.
-- The Vercel function is responsible for verifying that the
-- authenticated caller actually owns p_shop_id before calling this.
CREATE OR REPLACE FUNCTION checkout_sale(
  p_shop_id        UUID,
  p_items          JSONB,       -- [{inventoryId, qty, unitPrice, nameSnapshot}]
  p_discount       NUMERIC,
  p_payment_method TEXT,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_item       JSONB;
  v_order_id   UUID;
  v_subtotal   NUMERIC := 0;
  v_rows_affected INT;
BEGIN
  -- ── Idempotency check ──────────────────────────────────────
  -- If this key was already processed (e.g. client retry after
  -- network error) return the existing order without side effects.
  IF EXISTS (
    SELECT 1 FROM orders WHERE idempotency_key = p_idempotency_key
  ) THEN
    RETURN (
      SELECT to_jsonb(o)
      FROM orders o
      WHERE idempotency_key = p_idempotency_key
    );
  END IF;

  -- ── Stock decrement ────────────────────────────────────────
  -- Conditional UPDATE: only succeeds when stock >= requested qty.
  -- If another concurrent transaction already took the last unit,
  -- this UPDATE affects 0 rows and we raise P0001 immediately.
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    UPDATE inventory_items
    SET
      stock   = stock - (v_item->>'qty')::INT,
      version = version + 1
    WHERE
      id      = (v_item->>'inventoryId')::UUID
      AND shop_id = p_shop_id
      AND stock   >= (v_item->>'qty')::INT;

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
    subtotal, discount, total, payment_verified, idempotency_key
  )
  VALUES (
    p_shop_id,
    'SP-' || to_char(nextval('order_number_seq'), 'FM0000'),
    'POS',
    p_payment_method::payment_method,
    v_subtotal,
    p_discount,
    v_subtotal - p_discount,
    -- DIGITAL_PAY orders are manually reconciled; all others are
    -- considered verified at point of sale.
    p_payment_method != 'DIGITAL_PAY',
    p_idempotency_key
  )
  RETURNING id INTO v_order_id;

  -- ── Insert order lines ─────────────────────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO order_items (
      order_id, inventory_item_id, name_snapshot,
      qty, unit_price, line_total
    )
    VALUES (
      v_order_id,
      (v_item->>'inventoryId')::UUID,
      v_item->>'nameSnapshot',
      (v_item->>'qty')::INT,
      (v_item->>'unitPrice')::NUMERIC,
      (v_item->>'qty')::INT * (v_item->>'unitPrice')::NUMERIC
    );
  END LOOP;

  -- Return the full order row as JSON so the caller can surface
  -- the order number and other details to the Angular POS UI.
  RETURN (SELECT to_jsonb(o) FROM orders o WHERE id = v_order_id);
END;
$$;

-- ── get_dashboard_stats ───────────────────────────────────────
-- Aggregates KPI data for the Dashboard page.  Called directly
-- from Angular via supabase.rpc() — the RLS user client is used
-- so auth.uid() is valid.
CREATE OR REPLACE FUNCTION get_dashboard_stats(p_shop_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'new_orders_today',
      (SELECT COUNT(*) FROM orders
       WHERE shop_id = p_shop_id
         AND created_at >= CURRENT_DATE),
    'revenue_today',
      (SELECT COALESCE(SUM(total), 0) FROM orders
       WHERE shop_id = p_shop_id
         AND created_at >= CURRENT_DATE),
    'revenue_this_month',
      (SELECT COALESCE(SUM(total), 0) FROM orders
       WHERE shop_id = p_shop_id
         AND created_at >= date_trunc('month', now())),
    'total_inventory_items',
      (SELECT COUNT(*) FROM inventory_items
       WHERE shop_id = p_shop_id),
    'low_stock_count',
      (SELECT COUNT(*) FROM inventory_items
       WHERE shop_id = p_shop_id AND stock <= 5)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- ── get_revenue_chart_data ────────────────────────────────────
-- Returns daily revenue totals for a given number of past days,
-- used by the RevenueChartComponent dual-line chart.
-- p_days: 7 | 30 | 90
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
  SELECT
    d.day::DATE,
    COALESCE(SUM(o.total),  0) AS total_revenue,
    COALESCE(COUNT(o.id),   0) AS order_count
  FROM generate_series(
    (CURRENT_DATE - (p_days - 1) * INTERVAL '1 day'),
    CURRENT_DATE,
    INTERVAL '1 day'
  ) AS d(day)
  LEFT JOIN orders o
    ON o.shop_id = p_shop_id
    AND o.created_at::DATE = d.day::DATE
  GROUP BY d.day
  ORDER BY d.day;
$$;
