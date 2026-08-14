import { pool } from './db.js';
import { encrypt } from './cryptoService.js';

async function refreshInventory() {
  try {
    console.log('Refreshing inventory with correct encryption keys...');
    
    // Reset any reserved stuck inventory
    await pool.query(`UPDATE voucher_inventory SET status = 'AVAILABLE', reserved_at = NULL WHERE status = 'RESERVED'`);

    // Fetch existing product IDs
    const productsRes = await pool.query('SELECT id, title FROM voucher_products');
    
    for (const prod of productsRes.rows) {
      const code1 = encrypt(`${prod.title.substring(0, 4).toUpperCase()}-LIVE-7711`);
      const pin1 = encrypt('8844');
      const code2 = encrypt(`${prod.title.substring(0, 4).toUpperCase()}-LIVE-8822`);
      const pin2 = encrypt('9955');

      await pool.query(`
        INSERT INTO voucher_inventory (voucher_product_id, encrypted_code, encrypted_pin, serial_number, expiry_date, status)
        VALUES 
          ($1, $2, $3, $4, '2027-12-31', 'AVAILABLE'),
          ($1, $5, $6, $7, '2027-12-31', 'AVAILABLE')
      `, [prod.id, code1, pin1, 'SN-LIVE-101', code2, pin2, 'SN-LIVE-102']);
    }

    console.log('✅ Success: Clean, encrypted inventory loaded!');
  } catch (err) {
    console.error('Refresh error:', err.message);
  } finally {
    await pool.end();
    process.exit();
  }
}

refreshInventory();
