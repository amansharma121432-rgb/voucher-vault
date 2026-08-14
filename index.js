const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// 1. SUPABASE DATABASE CONNECTION
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ DB Error:', err.message);
    } else {
        console.log('✅ Supabase DB Connected Successfully');
    }
});

// 2. 24x7 TELEGRAM BOT (FIXED MARKDOWN)
const token = process.env.TELEGRAM_BOT_TOKEN;
if (token) {
    try {
        const bot = new TelegramBot(token, { polling: true });

        bot.on('polling_error', (error) => {
            console.error('Bot Polling Error:', error.message);
        });

        bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            const firstName = msg.from.first_name || 'Customer';
            const welcomeText = `👋 Hello ${firstName}!\n\nWelcome to Voucher Vault 🎁\n\nYour 24/7 Automated Voucher Store is Active and Ready!\n\n🌐 Website: https://voucher-vault-lhqo.onrender.com`;
            
            bot.sendMessage(chatId, welcomeText, {
                reply_markup: {
                    keyboard: [
                        [{ text: '🛍️ Browse Vouchers' }, { text: '📦 My Orders' }],
                        [{ text: '🆘 Support' }]
                    ],
                    resize_keyboard: true
                }
            }).catch(e => console.error('Send Error:', e.message));
        });

        bot.on('message', (msg) => {
            if (msg.text && !msg.text.startsWith('/start')) {
                bot.sendMessage(msg.chat.id, `Received: "${msg.text}". Use /start to open the menu.`).catch(e => console.error('Send Error:', e.message));
            }
        });

        console.log('🤖 Telegram Bot Worker attached and active!');
    } catch (e) {
        console.error('Bot error:', e.message);
    }
}

// 3. EXPRESS APP & ROUTES
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// REGISTER
const handleAuthRegister = async (req, res) => {
    try {
        const { email, password, full_name, name } = req.body;
        const userEmail = email ? email.trim().toLowerCase() : null;
        const userName = full_name || name || 'Customer';

        if (!userEmail || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const checkUser = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [userEmail]);
        if (checkUser.rows.length > 0) {
            return res.status(400).json({ error: 'Email already exists' });
        }

        const newUser = await pool.query(
            'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name',
            [userEmail, password, userName]
        );
        return res.json({ success: true, user: newUser.rows[0] });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

app.post('/api/auth/register', handleAuthRegister);
app.post('/api/register', handleAuthRegister);
app.post('/api/users/register', handleAuthRegister);

// LOGIN
const handleAuthLogin = async (req, res) => {
    try {
        const { email, password } = req.body;
        const userEmail = email ? email.trim().toLowerCase() : null;

        if (!userEmail || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [userEmail]);
        if (result.rows.length === 0 || result.rows[0].password_hash !== password) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const user = result.rows[0];
        return res.json({ success: true, user: { id: user.id, email: user.email, full_name: user.full_name } });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

app.post('/api/auth/login', handleAuthLogin);
app.post('/api/login', handleAuthLogin);
app.post('/api/users/login', handleAuthLogin);

// STORE PRODUCTS
const handleStoreData = async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.id, b.name, b.logo_url, c.id as category_id, c.name as category_name,
                   COALESCE(json_agg(
                       json_build_object(
                           'id', p.id,
                           'title', p.title,
                           'denomination', p.denomination,
                           'selling_price', p.selling_price,
                           'stock', (SELECT count(*) FROM voucher_inventory vi WHERE vi.voucher_product_id = p.id AND vi.status = 'AVAILABLE')
                       )
                   ) FILTER (WHERE p.id IS NOT NULL), '[]') as products
            FROM brands b
            LEFT JOIN categories c ON b.category_id = c.id
            LEFT JOIN voucher_products p ON b.id = p.brand_id
            GROUP BY b.id, b.name, b.logo_url, c.id, c.name
        `);
        return res.json(result.rows);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

app.get('/api/store/brands', handleStoreData);
app.get('/api/brands', handleStoreData);
app.get('/api/products', handleStoreData);

// SPA FALLBACK
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 All-in-One Voucher Vault Server running on port ${PORT}`);
});
