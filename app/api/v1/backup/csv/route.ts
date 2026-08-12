/**
 * GET /api/v1/backup/csv?table=<tableName>
 *
 * Downloads a single table as a CSV file named exactly after the DB table.
 * The ?table param controls which table is exported.
 *
 * Supported tables:
 *   shops | inventory_items | orders | order_items |
 *   customers | khata_transactions | devices
 *
 * Called once per table by the frontend BackupService — each call triggers
 * one browser file download named <table>.csv so filenames match DB exactly.
 */
import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors, AppError } from '@/lib/requireAuth';

// ── Allowed tables + their ordered columns (prevents SQL injection) ─────────
const TABLE_COLUMNS: Record<string, string[]> = {
  shops: [
    'id', 'owner_user_id', 'name', 'phone', 'address',
    'payment_qr_mime_type', 'auto_export_frequency', 'auto_print_receipt', 'created_at',
    // payment_qr_bytes omitted — binary, not CSV-serialisable
  ],
  inventory_items: [
    'id', 'shop_id', 'classification', 'name', 'description', 'category',
    'imei', 'imei2', 'sku', 'stock', 'cost_price', 'selling_price',
    'version', 'created_at', 'updated_at',
  ],
  orders: [
    'id', 'shop_id', 'order_number', 'customer_name', 'customer_phone',
    'customer_cnic', 'customer_id', 'channel', 'payment_method',
    'subtotal', 'discount', 'total', 'payment_verified',
    'idempotency_key', 'created_at',
  ],
  order_items: [
    'id', 'order_id', 'inventory_item_id', 'name_snapshot', 'description',
    'qty', 'unit_price', 'line_total',
  ],
  customers: [
    'id', 'shop_id', 'name', 'phone', 'cnic', 'notes',
    'balance', 'created_at', 'updated_at',
  ],
  khata_transactions: [
    'id', 'shop_id', 'customer_id', 'order_id', 'tx_type',
    'amount', 'notes', 'created_at', 'voided_at',
  ],
  devices: [
    'id', 'user_id', 'session_id', 'device_name',
    'last_active_at', 'created_at', 'revoked_at',
  ],
};

/** Escape a value for RFC 4180 CSV */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Wrap in quotes if contains comma, double-quote, newline, or carriage return
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Convert array of row objects to RFC 4180 CSV string */
function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.join(',');
  const body   = rows.map(row =>
    columns.map(col => csvCell(row[col])).join(','),
  ).join('\r\n');
  return header + '\r\n' + body;
}

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user  = await requireAuth(req);
    const table = new URL(req.url).searchParams.get('table') ?? '';

    const columns = TABLE_COLUMNS[table];
    if (!columns) {
      throw new AppError(
        `Unknown table "${table}". Supported: ${Object.keys(TABLE_COLUMNS).join(', ')}`,
        400,
      );
    }

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      // All tables are scoped to the authenticated shop via RLS.
      // For tables that have shop_id we add an explicit WHERE for defence-in-depth.
      // For order_items / khata_transactions we join through orders/customers.
      let rows: Record<string, unknown>[];

      const cols = columns.join(', ');

      if (table === 'shops') {
        const r = await client.query(
          `SELECT ${cols} FROM shops WHERE owner_user_id = $1`,
          [user.userId],
        );
        rows = r.rows;

      } else if (table === 'inventory_items') {
        const r = await client.query(
          `SELECT ${cols} FROM inventory_items WHERE shop_id = $1 ORDER BY name`,
          [user.shopId],
        );
        rows = r.rows;

      } else if (table === 'orders') {
        const r = await client.query(
          `SELECT ${cols} FROM orders WHERE shop_id = $1 ORDER BY created_at DESC`,
          [user.shopId],
        );
        rows = r.rows;

      } else if (table === 'order_items') {
        const r = await client.query(
          `SELECT oi.${columns.join(', oi.')}
           FROM   order_items oi
           JOIN   orders o ON o.id = oi.order_id
           WHERE  o.shop_id = $1
           ORDER  BY o.created_at DESC`,
          [user.shopId],
        );
        rows = r.rows;

      } else if (table === 'customers') {
        const r = await client.query(
          `SELECT ${cols} FROM customers WHERE shop_id = $1 ORDER BY name`,
          [user.shopId],
        );
        rows = r.rows;

      } else if (table === 'khata_transactions') {
        const r = await client.query(
          `SELECT ${cols} FROM khata_transactions WHERE shop_id = $1 ORDER BY created_at DESC`,
          [user.shopId],
        );
        rows = r.rows;

      } else if (table === 'devices') {
        const r = await client.query(
          `SELECT ${cols} FROM devices WHERE user_id = $1 ORDER BY created_at DESC`,
          [user.userId],
        );
        rows = r.rows;

      } else {
        throw new AppError('Unsupported table.', 400);
      }

      const csv      = toCsv(columns, rows);
      const filename = `${table}.csv`;

      return new Response(csv, {
        headers: {
          'Content-Type':        'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control':       'no-store',
        },
      });
    } finally { client.release(); }
  });
}
