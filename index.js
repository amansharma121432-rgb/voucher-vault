// 1. User submits UTR -> Order goes to PENDING status
app.post('/api/submit-utr', async (req, res) => {
  const { productId, userId, utr } = req.body;

  if (!utr || !productId) {
    return res.status(400).json({ error: 'UTR and Product ID are required' });
  }

  try {
    // Create an order entry in PENDING state
    const orderResult = await pool.query(
      `INSERT INTO orders (user_id, product_id, utr, status, created_at) 
       VALUES ($1, $2, $3, 'PENDING', NOW()) RETURNING id`,
      [userId || null, productId, utr]
    );

    res.json({
      success: true,
      message: 'Payment details submitted! Awaiting Admin Approval.',
      orderId: orderResult.rows[0].id
    });
  } catch (error) {
    console.error('Submit UTR Error:', error);
    res.status(500).json({ error: 'Failed to submit payment details' });
  }
});

// 2. Admin Approves Order -> Voucher Code & PIN Released
app.post('/api/admin/approve-order', async (req, res) => {
  const { orderId, adminSecret } = req.body;

  // Simple Admin Authentication Check
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized Admin Access' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get order details
    const orderRes = await client.query('SELECT * FROM orders WHERE id = $1 AND status = $2', [orderId, 'PENDING']);
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pending order not found' });
    }

    const order = orderRes.rows[0];

    // Lock and fetch an available voucher
    const voucherRes = await client.query(
      `SELECT id, code, pin FROM vouchers 
       WHERE product_id = $1 AND is_claimed = false 
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [order.product_id]
    );

    if (voucherRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Out of stock! Cannot approve order.' });
    }

    const voucher = voucherRes.rows[0];

    // Assign voucher and update order to APPROVED
    await client.query(
      `UPDATE vouchers SET is_claimed = true, claimed_by_user_id = $1, claimed_at = NOW() WHERE id = $2`,
      [order.user_id, voucher.id]
    );

    await client.query(
      `UPDATE orders SET status = 'APPROVED', voucher_id = $1 WHERE id = $2`,
      [voucher.id, orderId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Order Approved & Voucher Code Unlocked!' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Approval Error:', error);
    res.status(500).json({ error: 'Approval failed' });
  } finally {
    client.release();
  }
});
