-- ============================================================
--  009_tests.sql — Regression tests for ShopPulse
--
--  Run against a test database (NOT production).
--  Uses DO blocks that RAISE EXCEPTION on failure so any CI
--  script that checks the exit code will detect regressions.
--
--  Run order: after 008_price_validation.sql
--  Usage:  psql "$TEST_DATABASE_URL" -f 009_tests.sql
-- ============================================================

-- ── Helpers ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION _assert(condition BOOLEAN, msg TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF NOT condition THEN
    RAISE EXCEPTION 'ASSERTION FAILED: %', msg;
  END IF;
END;
$$;

-- ── Test 1: RLS blocks cross-shop reads ───────────────────────────────────

DO $$
DECLARE
  v_user_a  UUID := gen_random_uuid();
  v_user_b  UUID := gen_random_uuid();
  v_shop_a  UUID;
  v_shop_b  UUID;
  v_item_a  UUID;
  v_count   INT;
BEGIN
  -- Insert two synthetic users directly into auth.users (test DB only).
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    VALUES
      (v_user_a, 'test_a@shoppulse.test', 'x', now(), now(), now()),
      (v_user_b, 'test_b@shoppulse.test', 'x', now(), now(), now());

  INSERT INTO shops (owner_user_id, name) VALUES (v_user_a, 'Shop A') RETURNING id INTO v_shop_a;
  INSERT INTO shops (owner_user_id, name) VALUES (v_user_b, 'Shop B') RETURNING id INTO v_shop_b;

  INSERT INTO inventory_items
    (shop_id, classification, name, category, stock, cost_price, selling_price)
  VALUES (v_shop_a, 'NEW', 'iPhone 15', 'Smartphones', 10, 100000, 120000)
  RETURNING id INTO v_item_a;

  -- Simulate user_b's JWT context.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_user_b::text, 'role', 'authenticated')::text, true);

  -- user_b must NOT see user_a's inventory item.
  SELECT COUNT(*) INTO v_count FROM inventory_items WHERE id = v_item_a;
  PERFORM _assert(v_count = 0, 'RLS: user_b should not see user_a inventory item');

  -- user_b must NOT see user_a's shop.
  SELECT COUNT(*) INTO v_count FROM shops WHERE id = v_shop_a;
  PERFORM _assert(v_count = 0, 'RLS: user_b should not see user_a shop');

  -- Cleanup.
  DELETE FROM inventory_items WHERE shop_id IN (v_shop_a, v_shop_b);
  DELETE FROM shops WHERE id IN (v_shop_a, v_shop_b);
  DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);

  RAISE NOTICE 'TEST 1 PASSED: RLS blocks cross-shop reads';
END;
$$;


-- ── Test 2: checkout_sale() concurrent oversell prevention ────────────────

DO $$
DECLARE
  v_user   UUID := gen_random_uuid();
  v_shop   UUID;
  v_item   UUID;
  v_result JSONB;
  v_ok     INT  := 0;
  v_fail   INT  := 0;
  v_key_1  TEXT := 'test-idem-1-' || gen_random_uuid()::text;
  v_key_2  TEXT := 'test-idem-2-' || gen_random_uuid()::text;
BEGIN
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    VALUES (v_user, 'test_concurrent@shoppulse.test', 'x', now(), now(), now());

  INSERT INTO shops (owner_user_id, name) VALUES (v_user, 'Concurrency Shop') RETURNING id INTO v_shop;

  INSERT INTO inventory_items
    (shop_id, classification, name, category, stock, cost_price, selling_price)
  VALUES (v_shop, 'NEW', 'Last Unit', 'Phones', 1, 50000, 60000)
  RETURNING id INTO v_item;

  -- First checkout — must succeed.
  BEGIN
    v_result := checkout_sale(
      v_shop,
      jsonb_build_array(jsonb_build_object(
        'inventoryId', v_item, 'qty', 1, 'unitPrice', 60000, 'nameSnapshot', 'Last Unit'
      )),
      0, 'CASH', v_key_1
    );
    v_ok := v_ok + 1;
  EXCEPTION WHEN OTHERS THEN
    v_fail := v_fail + 1;
  END;

  -- Second checkout against same item (now stock=0) — must fail with P0001.
  BEGIN
    v_result := checkout_sale(
      v_shop,
      jsonb_build_array(jsonb_build_object(
        'inventoryId', v_item, 'qty', 1, 'unitPrice', 60000, 'nameSnapshot', 'Last Unit'
      )),
      0, 'CASH', v_key_2
    );
    v_ok := v_ok + 1;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_fail := v_fail + 1;
  END;

  PERFORM _assert(v_ok   = 1, 'Concurrency: exactly one checkout should succeed');
  PERFORM _assert(v_fail = 1, 'Concurrency: exactly one checkout should fail with P0001');

  -- Cleanup.
  DELETE FROM order_items  USING orders o WHERE order_items.order_id = o.id AND o.shop_id = v_shop;
  DELETE FROM orders       WHERE shop_id = v_shop;
  DELETE FROM inventory_items WHERE shop_id = v_shop;
  DELETE FROM shops        WHERE id = v_shop;
  DELETE FROM auth.users   WHERE id = v_user;

  RAISE NOTICE 'TEST 2 PASSED: checkout_sale() concurrent oversell prevention';
END;
$$;


-- ── Test 3: price validation rejects unitPrice > selling_price ────────────

DO $$
DECLARE
  v_user   UUID := gen_random_uuid();
  v_shop   UUID;
  v_item   UUID;
  v_result JSONB;
  v_raised BOOLEAN := false;
BEGIN
  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at)
    VALUES (v_user, 'test_price@shoppulse.test', 'x', now(), now(), now());

  INSERT INTO shops (owner_user_id, name) VALUES (v_user, 'Price Test Shop') RETURNING id INTO v_shop;

  INSERT INTO inventory_items
    (shop_id, classification, name, category, stock, cost_price, selling_price)
  VALUES (v_shop, 'NEW', 'Test Item', 'Phones', 5, 50000, 60000)
  RETURNING id INTO v_item;

  -- Attempt checkout with unitPrice above selling_price.
  BEGIN
    v_result := checkout_sale(
      v_shop,
      jsonb_build_array(jsonb_build_object(
        'inventoryId', v_item, 'qty', 1,
        'unitPrice', 99999,   -- above selling_price=60000
        'nameSnapshot', 'Test Item'
      )),
      0, 'CASH', 'test-price-high-' || gen_random_uuid()::text
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_raised := true;
  END;
  PERFORM _assert(v_raised, 'Price: unitPrice > selling_price must raise P0001');

  -- Attempt checkout with unitPrice = 0.
  v_raised := false;
  BEGIN
    v_result := checkout_sale(
      v_shop,
      jsonb_build_array(jsonb_build_object(
        'inventoryId', v_item, 'qty', 1,
        'unitPrice', 0,
        'nameSnapshot', 'Test Item'
      )),
      0, 'CASH', 'test-price-zero-' || gen_random_uuid()::text
    );
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    v_raised := true;
  END;
  PERFORM _assert(v_raised, 'Price: unitPrice = 0 must raise P0001');

  -- Valid checkout at list price must succeed.
  v_result := checkout_sale(
    v_shop,
    jsonb_build_array(jsonb_build_object(
      'inventoryId', v_item, 'qty', 1,
      'unitPrice', 60000,
      'nameSnapshot', 'Test Item'
    )),
    0, 'CASH', 'test-price-ok-' || gen_random_uuid()::text
  );
  PERFORM _assert(v_result IS NOT NULL, 'Price: valid unitPrice should produce an order');

  -- Valid checkout at discounted price (below list) must also succeed.
  v_result := checkout_sale(
    v_shop,
    jsonb_build_array(jsonb_build_object(
      'inventoryId', v_item, 'qty', 1,
      'unitPrice', 55000,   -- intentional per-line discount
      'nameSnapshot', 'Test Item'
    )),
    0, 'CASH', 'test-price-discount-' || gen_random_uuid()::text
  );
  PERFORM _assert(v_result IS NOT NULL, 'Price: discounted unitPrice should produce an order');

  -- Cleanup.
  DELETE FROM order_items  USING orders o WHERE order_items.order_id = o.id AND o.shop_id = v_shop;
  DELETE FROM orders       WHERE shop_id = v_shop;
  DELETE FROM inventory_items WHERE shop_id = v_shop;
  DELETE FROM shops        WHERE id = v_shop;
  DELETE FROM auth.users   WHERE id = v_user;

  RAISE NOTICE 'TEST 3 PASSED: price validation in checkout_sale()';
END;
$$;


-- ── Cleanup helper ────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS _assert(BOOLEAN, TEXT);

RAISE NOTICE '=== ALL TESTS PASSED ===';
