require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// PostgreSQL Connection Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // e.g., Render / PostgreSQL connection string
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key_change_this_in_production';

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

// Register Route
app.post('/api/register', async (req, res) => {
  const { email, password, full_name } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Check if user already exists
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists with this email' });
    }

    // Hash Password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Save User
    const newUser = await pool.query(
      'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name',
      [email, password_hash, full_name || null]
    );

    // Generate JWT Token
    const token = jwt.sign({ userId: newUser.rows[0].id }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: newUser.rows[0]
    });
  } catch (error) {
    console.error('Register Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login Route
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // Find User
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const user = userResult.rows[0];

    // Verify Password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    // Generate JWT Token
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==========================================
// 2. STORE & BRANDS ROUTES
// ==========================================

// Get All Active Brands & Products with Available Stock Count
app.get('/api/brands', async (req, res) => {
  try {
    const queryText = `
      SELECT 
        b.id AS brand_id,
        b.name AS brand_name,
        p.id AS product_id,
        p.title AS product_title,
        p.selling_price,
        COUNT(v.id) FILTER (WHERE v.is_claimed = false) AS stock
      FROM brands b
      JOIN products p ON b.id = p.brand_id
      LEFT JOIN vouchers v ON p.id = v.product_id
      GROUP BY b.id, b.name, p.id, p.title, p.selling_price
      ORDER BY b.name ASC;
    `;

    const result = await pool.query(queryText);

    // Transform DB rows into Front-end expected Nested JSON Format
    const brandsMap = {};

    result.rows.forEach(row => {
      if (!brandsMap[row.brand_id]) {
        brandsMap[row.brand_id] = {
          id: row.brand_id,
          name: row.brand_name,
          products: []
        };
      }

      brandsMap[row.brand_id].products.push({
        id: row.product_id,
        title: row.product_title,
        selling_price: parseFloat(row.selling_price),
        stock: parseInt(row.stock || 0)
      });
    });

    const formattedBrands = Object.values(brandsMap);
    res.json(formattedBrands);
  } catch (error) {
    console.error('Get Brands Error:', error);
    res.status(500).json({ error: 'Failed to fetch store data' });
  }
});

// ==========================================
// 3. VOUCHER UNLOCK / CLAIM ROUTE
// ==========================================

app.post('/api/claim-voucher', async (req, res) => {
  const { productId, userId } = req.body;

  if (!productId) {
    return res.status(400).json({ error: 'Product ID is required' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN'); // Database Transaction Start

    // Pick 1 available (unclaimed) voucher and lock the row to avoid race condition
    const selectQuery = `
      SELECT id, code, pin 
      FROM vouchers 
      WHERE product_id = $1 AND is_claimed = false 
      LIMIT 1 
      FOR UPDATE SKIP LOCKED;
    `;
    const voucherRes = await client.query(selectQuery, [productId]);

    if (voucherRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Out of stock! No vouchers available.' });
    }

    const voucher = voucherRes.rows[0];

    // Mark Voucher as Claimed
    await client.query(
      'UPDATE vouchers SET is_claimed = true, claimed_by_user_id = $1, claimed_at = NOW() WHERE id = $2',
      [userId || null, voucher.id]
    );

    await client.query('COMMIT'); // Commit Transaction

    res.json({
      success: true,
      code: voucher.code,
      pin: voucher.pin
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Claim Voucher Error:', error);
    res.status(500).json({ error: 'Failed to process voucher claim' });
  } finally {
    client.release();
  }
});

// Server Start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Voucher Vault Server running on port ${PORT}`);
});
