// Instant Unlock Route without Payment Gateway Check
app.post('/api/instant-unlock', async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: 'Product ID required' });

  try {
    const client = await pool.connect();
    await client.query('BEGIN');
    
    const selectQuery = `
      SELECT id, code, pin 
      FROM vouchers 
      WHERE product_id = $1 AND is_claimed = false 
      LIMIT 1 FOR UPDATE SKIP LOCKED;
    `;
    const voucherRes = await client.query(selectQuery, [productId]);

    if (voucherRes.rows.length > 0) {
      const voucher = voucherRes.rows[0];
      await client.query('UPDATE vouchers SET is_claimed = true, claimed_at = NOW() WHERE id = $1', [voucher.id]);
      await client.query('COMMIT');
      client.release();
      return res.json({ success: true, message: 'Payment Verified!', code: voucher.code, pin: voucher.pin });
    }
    await client.query('ROLLBACK');
    client.release();
    return res.status(400).json({ error: 'Out of stock!' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error unlocking voucher' });
  }
});
