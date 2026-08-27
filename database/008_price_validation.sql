-- ============================================================
--  008_price_validation.sql
--  ShopPulse — Server-side price validation in checkout_sale()
--
--  Policy chosen: client-supplied unitPrice must be > 0 and
--  <= inventory_items.selling_price. This allows intentional
--  per-line discounts (cashier overrides) while rejecting
--  tampered or zero prices. The DB's selling_price is the upper
--  bound; going below zero or above the list price is rejected
--  with a P0001 error (mapped to HTTP 409 by handleErrors).
--
--  Run order: after 007_khata.sql
-- ============================================================

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
  v_item              JSONB;
  v_order_id          UUID;
  v_subtotal          NUMERIC := 0;
  v_rows_affected     INT;
  v_db_selling_price  NUMERIC;
  v_unit_price        NUMERIC;
  v_qty               INT;
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

  -- ── Stock decrement + price validation ────────────────────
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty        := (v_item->>'qty')::INT;
    v_unit_price := (v_item->>'unitPrice')::NUMERIC;

    -- Reject zero / negative unit prices.
    IF v_unit_price <= 0 THEN
      RAISE EXCEPTION 'Unit price must be greater than 0 for item %',
        v_item->>'inventoryId'
        USING ERRCODE = 'P0001';
    END IF;

    -- Fetch the authoritative selling price from the DB and validate
    -- that the client-supplied price does not exceed it.
    SELECT selling_price
      INTO v_db_selling_price
      FROM inventory_items
     WHERE id      = (v_item->>'inventoryId')::UUID
       AND shop_id = p_shop_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item % not found in this shop',
        v_item->>'inventoryId'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_unit_price > v_db_selling_price THEN
      RAISE EXCEPTION 'Unit price % exceeds list price % for item %',
        v_unit_price, v_db_selling_price, v_item->>'inventoryId'
        USING ERRCODE = 'P0001';
    END IF;

    -- Atomic stock decrement — fails if another concurrent checkout
    -- already took the last unit.
    UPDATE inventory_items
       SET stock   = stock - v_qty,
           version = version + 1
     WHERE id      = (v_item->>'inventoryId')::UUID
       AND shop_id = p_shop_id
       AND stock  >= v_qty;

    GET DIAGNOSTICS v_rows_affected = ROW_COUNT;

    IF v_rows_affected = 0 THEN
      RAISE EXCEPTION 'Insufficient stock for item %',
        v_item->>'inventoryId'
        USING ERRCODE = 'P0001';
    END IF;

    v_subtotal := v_subtotal + v_qty * v_unit_price;
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
      v_item->>'description',
      (v_item->>'qty')::INT,
      (v_item->>'unitPrice')::NUMERIC,
      (v_item->>'qty')::INT * (v_item->>'unitPrice')::NUMERIC
    );
  END LOOP;

  RETURN (SELECT to_jsonb(o) FROM orders o WHERE id = v_order_id);
END;
$$;
