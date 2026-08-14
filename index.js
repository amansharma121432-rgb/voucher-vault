import cron from 'node-cron';
import express from 'express';
import crypto from 'crypto';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import QRCode from 'qrcode';
import { pool } from './db.js';
import { encrypt, decrypt } from './cryptoService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_vault_2026';
const UPI_ID = process.env.UPI_ID || 'merchant@upi';
const MERCHANT_NAME = 'Voucher Vault';

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use(express.static('public'));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

// 1. Signup
app.post('/api/v1/auth/signup', async (req, res) => {
  const { fullName, email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const nameToSave = fullName && fullName.trim() ? fullName.trim() : email.split('@')[0];

  try {
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, full_name`,
      [nameToSave, email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, fullName: user.full_name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: 'User created successfully', token, user });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email is already registered' });
    res.status(500).json({ error: err.message });
  }
});

// 2. Login
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password' });

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email, fullName: user.full_name }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, fullName: user.full_name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. User Orders
app.get('/api/v1/auth/me', authenticateToken, async (req, res) => {
  try {
    const ordersRes = await pool.query(
      `SELECT o.id, COALESCE(o.final_payable, o.total_amount) AS total_amount, o.status, o.created_at
       FROM orders o
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json({ user: req.user, orders: ordersRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Products Listing
app.get('/api/v1/products', async (req, res) => {
  try {
    const query = `
      SELECT 
        vp.id AS product_id,
        vp.title,
        vp.denomination,
        vp.selling_price,
        b.name AS brand_name,
        b.logo_url,
        c.name AS category_name,
        c.slug AS category_slug,
        COUNT(vi.id) FILTER (WHERE vi.status = 'AVAILABLE') AS available_stock
      FROM voucher_products vp
      JOIN brands b ON vp.brand_id = b.id
      JOIN categories c ON b.category_id = c.id
      LEFT JOIN voucher_inventory vi ON vp.id = vi.voucher_product_id
      WHERE vp.is_active = TRUE
      GROUP BY vp.id, b.name, b.logo_url, c.name, c.slug;
    `;
    const { rows } = await pool.query(query);
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Admin - Bulk Ingest
app.post('/api/v1/admin/vouchers/bulk', async (req, res) => {
  const { voucherProductId, vouchers } = req.body;
  if (!voucherProductId || !vouchers || !Array.isArray(vouchers)) {
    return res.status(400).json({ error: 'Invalid payload.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertQuery = `
      INSERT INTO voucher_inventory (voucher_product_id, encrypted_code, encrypted_pin, serial_number, expiry_date, status)
      VALUES ($1, $2, $3, $4, $5, 'AVAILABLE')
    `;
    for (const v of vouchers) {
      const encCode = encrypt(v.code);
      const encPin = v.pin ? encrypt(v.pin) : null;
      await client.query(insertQuery, [voucherProductId, encCode, encPin, v.serialNumber, v.expiryDate]);
    }
    await client.query('COMMIT');
    res.json({ message: `Successfully loaded ${vouchers.length} vouchers.` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 6. Checkout & QR
app.post('/api/v1/checkout/reserve', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  let userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userId = decoded.id;
    } catch(e) {}
  }

  const { items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let totalAmount = 0;
    const reservedBatch = [];

    for (const item of items) {
      const prodRes = await client.query('SELECT selling_price FROM voucher_products WHERE id = $1', [item.voucherProductId]);
      if (prodRes.rows.length === 0) throw new Error('Product not found');
      
      const price = prodRes.rows[0].selling_price;
      const subtotal = price * item.quantity;
      totalAmount += subtotal;

      const lockQuery = `
        SELECT id FROM voucher_inventory
        WHERE voucher_product_id = $1 AND status = 'AVAILABLE'
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `;
      const lockRes = await client.query(lockQuery, [item.voucherProductId, item.quantity]);
      if (lockRes.rows.length < item.quantity) {
        throw new Error('Not enough inventory in stock');
      }

      const invIds = lockRes.rows.map(r => r.id);
      await client.query(
        `UPDATE voucher_inventory SET status = 'RESERVED', reserved_at = NOW() WHERE id = ANY($1)`,
        [invIds]
      );
      reservedBatch.push({ productId: item.voucherProductId, price, subtotal, invIds });
    }

    const orderRes = await client.query(
      `INSERT INTO orders (user_id, total_amount, final_payable, status)
       VALUES ($1, $2, $2, 'PENDING') RETURNING id`,
      [userId, totalAmount]
    );
    const orderId = orderRes.rows[0].id;

    for (const r of reservedBatch) {
      const itemRes = await client.query(
        `INSERT INTO order_items (order_id, voucher_product_id, quantity, unit_price, subtotal)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orderId, r.productId, r.invIds.length, r.price, r.subtotal]
      );
      const orderItemId = itemRes.rows[0].id;

      for (const invId of r.invIds) {
        await client.query(
          `INSERT INTO order_delivered_vouchers (order_id, order_item_id, inventory_id) VALUES ($1, $2, $3)`,
          [orderId, orderItemId, invId]
        );
      }
    }

    await client.query('COMMIT');

    const upiUrl = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${totalAmount}&cu=INR&tr=${orderId}`;
    const qrDataUrl = await QRCode.toDataURL(upiUrl, { width: 280, margin: 1 });

    res.json({ orderId, totalAmount, qrDataUrl, upiUrl });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 7. Payment Verification Webhook (Clean status update)
app.post('/api/v1/webhooks/payment', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      `SELECT id FROM orders WHERE id = $1 AND status = 'PENDING' FOR UPDATE`,
      [orderId]
    );
    if (orderRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or already processed' });
    }
    
    await client.query(`UPDATE orders SET status = 'COMPLETED' WHERE id = $1`, [orderId]);
    const odvRes = await client.query(`SELECT inventory_id FROM order_delivered_vouchers WHERE order_id = $1`, [orderId]);
    const invIds = odvRes.rows.map(r => r.inventory_id);
    if (invIds.length > 0) {
      await client.query(`UPDATE voucher_inventory SET status = 'SOLD' WHERE id = ANY($1)`, [invIds]);
    }
    await client.query('COMMIT');
    res.json({ status: 'fulfilled', orderId });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 8. Order Status Polling
app.get('/api/v1/orders/:orderId/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT status FROM orders WHERE id = $1', [req.params.orderId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json({ status: result.rows[0].status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Retrieve Decrypted Vouchers
app.get('/api/v1/orders/:orderId/vouchers', async (req, res) => {
  try {
    const query = `
      SELECT vi.serial_number, vi.expiry_date, vi.encrypted_code, vi.encrypted_pin, vp.title, o.status
      FROM orders o
      JOIN order_delivered_vouchers odv ON o.id = odv.order_id
      JOIN voucher_inventory vi ON odv.inventory_id = vi.id
      JOIN voucher_products vp ON vi.voucher_product_id = vp.id
      WHERE o.id = $1;
    `;
    const { rows } = await pool.query(query, [req.params.orderId]);
    
    if (rows.length === 0) {
      const checkOrder = await pool.query('SELECT status FROM orders WHERE id = $1', [req.params.orderId]);
      if (checkOrder.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      return res.status(404).json({ error: 'No vouchers assigned to this order yet' });
    }

    const vouchers = rows.map(r => ({
      title: r.title,
      code: decrypt(r.encrypted_code),
      pin: r.encrypted_pin ? decrypt(r.encrypted_pin) : null,
      expiryDate: r.expiry_date
    }));
    res.json({ vouchers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-Release Cron
cron.schedule('* * * * *', async () => {
  try {
    await pool.query(`
      UPDATE voucher_inventory
      SET status = 'AVAILABLE', reserved_at = NULL
      WHERE status = 'RESERVED' AND reserved_at < NOW() - INTERVAL '10 minutes';
    `);
  } catch (err) {}
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
