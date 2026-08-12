-- ============================================================
--  005_notify_triggers.sql
--  ShopPulse — Postgres LISTEN/NOTIFY triggers for the Python backend.
--  Run order: 5 of 5
--
--  Replaces the Supabase Realtime subscription used in the previous
--  architecture. The Python backend's single dedicated asyncpg connection
--  LISTENs on 'shop_changes'; these triggers NOTIFY it with a small
--  payload on every relevant table change.
--
--  Payload is intentionally tiny (well under the 8000-byte NOTIFY limit).
--  The backend re-fetches the full row via its normal query path before
--  broadcasting, so the shape sent to browsers always matches a REST GET.
-- ============================================================

-- ── Notify function ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_shop_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_shop_id uuid;
BEGIN
  -- Resolve shop_id depending on which table fired
  CASE TG_TABLE_NAME
    WHEN 'inventory_items' THEN
      v_shop_id := COALESCE(NEW.shop_id, OLD.shop_id);
    WHEN 'orders' THEN
      v_shop_id := COALESCE(NEW.shop_id, OLD.shop_id);
    WHEN 'shops' THEN
      v_shop_id := COALESCE(NEW.id, OLD.id);
    WHEN 'devices' THEN
      -- devices don't have shop_id; listener uses user_id to find shop
      v_shop_id := NULL;
    ELSE
      v_shop_id := NULL;
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

-- ── Triggers ───────────────────────────────────────────────────

-- Drop existing triggers first (idempotent re-run)
DROP TRIGGER IF EXISTS trg_inventory_notify ON inventory_items;
DROP TRIGGER IF EXISTS trg_orders_notify    ON orders;
DROP TRIGGER IF EXISTS trg_shops_notify     ON shops;
DROP TRIGGER IF EXISTS trg_devices_notify   ON devices;

CREATE TRIGGER trg_inventory_notify
  AFTER INSERT OR UPDATE OR DELETE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION notify_shop_change();

CREATE TRIGGER trg_orders_notify
  AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION notify_shop_change();

CREATE TRIGGER trg_shops_notify
  AFTER UPDATE ON shops
  FOR EACH ROW EXECUTE FUNCTION notify_shop_change();

CREATE TRIGGER trg_devices_notify
  AFTER INSERT OR UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION notify_shop_change();

-- ── Remove old Supabase Realtime publication entries ───────────
-- The Python backend now handles realtime fan-out directly.
-- Remove the tables from the realtime publication to avoid
-- double-processing (Supabase Realtime is no longer used).
-- Note: this will fail silently if the publication doesn't exist.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS inventory_items;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS orders;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS devices;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
