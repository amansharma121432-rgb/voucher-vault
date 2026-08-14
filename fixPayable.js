import { pool } from './db.js';

async function fixFinalPayable() {
  try {
    console.log('Fixing orders table constraints...');
    await pool.query(`
      ALTER TABLE orders ALTER COLUMN final_payable DROP NOT NULL;
    `);
    console.log('✅ Success: Constraint relaxed successfully!');
  } catch (err) {
    try {
      await pool.query(`
        ALTER TABLE orders ALTER COLUMN final_payable SET DEFAULT 0;
      `);
      console.log('✅ Success: Default value added to final_payable!');
    } catch (e) {
      console.error('Migration error:', e.message);
    }
  } finally {
    await pool.end();
    process.exit();
  }
}

fixFinalPayable();
