import { pool } from './db.js';

async function fixOrdersTable() {
  try {
    console.log('Adding payment_gateway_order_id column to orders table...');
    
    await pool.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS payment_gateway_order_id VARCHAR(255);
    `);

    const check = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='orders' AND column_name='payment_gateway_order_id';
    `);

    if (check.rows.length > 0) {
      console.log('✅ Success: Column "payment_gateway_order_id" is now active in orders table!');
    } else {
      console.log('⚠️ Column could not be verified.');
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await pool.end();
    process.exit();
  }
}

fixOrdersTable();
