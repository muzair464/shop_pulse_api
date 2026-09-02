-- ============================================================
--  010_receipt_footer.sql
--  Add receipt_footer_message column to shops table
-- ============================================================

ALTER TABLE shops
ADD COLUMN IF NOT EXISTS receipt_footer_message TEXT;

COMMENT ON COLUMN shops.receipt_footer_message IS 'Custom message displayed at the bottom of printed receipts';
