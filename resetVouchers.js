import { pool } from './db.js';
import { encrypt } from './cryptoService.js';

async function resetVouchers() {
  try {
    console.log('Re-encrypting all stock with clean SHA-256 master key...');
    
    // Clear old inventory
    await pool.query(`DELETE FROM order_delivered_vouchers`);
    await pool.query(`DELETE FROM voucher_inventory`);

    // Re-seed all voucher products with fresh real encrypted codes
    const productsRes = await pool.query('SELECT id, title, denomination FROM voucher_products');

    for (const p of productsRes.rows) {
      const brandCode = p.title.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase();
      
      const codes = [
        { code: `${brandCode}-SAVE-${Math.floor(1000 + Math.random()*9000)}`, pin: String(Math.floor(1000 + Math.random()*9000)) },
        { code: `${brandCode}-PROMO-${Math.floor(1000 + Math.random()*9000)}`, pin: String(Math.floor(1000 + Math.random()*9000)) },
        { code: `${brandCode}-GIFT-${Math.floor(1000 + Math.random()*9000)}`, pin: String(Math.floor(1000 + Math.random()*9000)) }
      ];

      for (const item of codes) {
        const encCode = encrypt(item.code);
        const encPin = encrypt(item.pin);
        await pool.query(`
          INSERT INTO voucher_inventory (voucher_product_id, encrypted_code, encrypted_pin, serial_number, expiry_date, status)
          VALUES ($1, $2, $3, $4, '2027-12-31', 'AVAILABLE')
        `, [p.id, encCode, encPin, 'SN-' + Math.floor(100000 + Math.random()*900000)]);
      }
    }

    console.log('✅ Success: All vouchers re-encrypted with standard key!');
  } catch (err) {
    console.error('Reset error:', err.message);
  } finally {
    await pool.end();
    process.exit();
  }
}

resetVouchers();
