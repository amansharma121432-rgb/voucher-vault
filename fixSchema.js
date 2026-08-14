import { pool } from './db.js';

async function fixSchema() {
  try {
    console.log('Adding missing payment_gateway_order_id column...');
    await pool.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS payment_gateway_order_id VARCHAR(255);
    `);
    console.log('Database schema updated successfully! ✅');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    await pool.end();
    process.exit();
  }
}

fixSchema();
