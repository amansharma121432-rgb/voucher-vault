import { pool } from './db.js';

async function fixDeliveredVouchers() {
  try {
    console.log('Fixing constraints on order_delivered_vouchers...');
    await pool.query(`
      ALTER TABLE order_delivered_vouchers 
      ALTER COLUMN order_item_id DROP NOT NULL;
    `);
    console.log('✅ Success: order_delivered_vouchers constraint updated!');
  } catch (err) {
    console.log('Note/Status:', err.message);
  } finally {
    await pool.end();
    process.exit();
  }
}

fixDeliveredVouchers();
