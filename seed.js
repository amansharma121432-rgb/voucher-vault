import { pool } from './db.js';

async function seedDatabase() {
  try {
    console.log('Inserting categories, brands & products...');

    // 1. Safe Category Inserts
    await pool.query(`
      INSERT INTO categories (name, slug)
      VALUES 
        ('Food', 'food'), 
        ('Travel', 'travel'), 
        ('Fashion', 'fashion'), 
        ('Electronics', 'electronics'), 
        ('Groceries', 'groceries')
      ON CONFLICT (slug) DO NOTHING;
    `);

    // 2. Safe Brand Inserts
    await pool.query(`
      INSERT INTO brands (name, slug, logo_url, category_id)
      VALUES 
        ('Flipkart', 'flipkart', 'https://logos-world.net/wp-content/uploads/2020/11/Flipkart-Logo.png', (SELECT id FROM categories WHERE slug='fashion' LIMIT 1)),
        ('Swiggy', 'swiggy', 'https://iconape.com/wp-content/png_logo_vector/swiggy-logo.png', (SELECT id FROM categories WHERE slug='food' LIMIT 1)),
        ('Zomato', 'zomato', 'https://upload.wikimedia.org/wikipedia/commons/7/75/Zomato_logo.png', (SELECT id FROM categories WHERE slug='food' LIMIT 1))
      ON CONFLICT (slug) DO NOTHING;
    `);

    // 3. Safe Product Inserts
    await pool.query(`
      INSERT INTO voucher_products (id, brand_id, title, denomination, selling_price, is_active)
      VALUES 
        ('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', (SELECT id FROM brands WHERE slug='flipkart' LIMIT 1), 'Flipkart ₹1000 Voucher', 1000, 950, TRUE),
        ('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55', (SELECT id FROM brands WHERE slug='swiggy' LIMIT 1), 'Swiggy ₹250 Voucher', 250, 220, TRUE),
        ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a66', (SELECT id FROM brands WHERE slug='zomato' LIMIT 1), 'Zomato ₹500 Pro Pass', 500, 420, TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log('Database updated successfully! ✅');
  } catch (err) {
    console.error('Error seeding DB:', err.message);
  } finally {
    process.exit();
  }
}

seedDatabase();
