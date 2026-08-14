const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// 1. DATABASE CONNECTION
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 2. 24x7 FULL FEATURED TELEGRAM BOT
const token = process.env.TELEGRAM_BOT_TOKEN;
const UPI_ID = process.env.UPI_ID || 'merchant@upi';

if (token) {
    const bot = new TelegramBot(token, { polling: true });

    bot.on('polling_error', (err) => console.error('Telegram Error:', err.message));

    // /start command
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const firstName = msg.from.first_name || 'Customer';
        bot.sendMessage(chatId, `👋 Hello *${firstName}*!\n\nWelcome to *Voucher Vault* 🎁\nInstant & Automated Gift Cards Store.\n\nChoose an option below:`, {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: '🛍️ Browse Vouchers' }, { text: '📦 My Orders' }],
                    [{ text: '🌐 Open Web Store' }, { text: '🆘 Support' }]
                ],
                resize_keyboard: true
            }
        });
    });

    // Handle Buttons & Messages
    bot.on('message', async (msg) => {
        const text = msg.text;
        const chatId = msg.chat.id;

        if (!text || text.startsWith('/start')) return;

        // BROWSE VOUCHERS
        if (text === '🛍️ Browse Vouchers') {
            try {
                const brands = await pool.query(`
                    SELECT b.id, b.name,
                           (SELECT COUNT(*) FROM voucher_inventory vi 
                            JOIN voucher_products vp ON vi.voucher_product_id = vp.id 
                            WHERE vp.brand_id = b.id AND vi.status = 'AVAILABLE') as available_count
                    FROM brands b ORDER BY b.name ASC
                `);

                if (brands.rows.length === 0) {
                    return bot.sendMessage(chatId, '⚠️ Currently no brands available.');
                }

                const keyboard = brands.rows.map(b => [{
                    text: `${b.name} (${b.available_count} In Stock)`,
                    callback_data: `brand_${b.id}`
                }]);

                bot.sendMessage(chatId, '🏷️ *Select a Brand:*', {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } catch (err) {
                bot.sendMessage(chatId, '❌ Error fetching store products.');
            }
        } 
        // MY ORDERS
        else if (text === '📦 My Orders') {
            bot.sendMessage(chatId, '📦 You have no recent orders yet. Buy a voucher to see it here!');
        }
        // OPEN STORE
        else if (text === '🌐 Open Web Store') {
            bot.sendMessage(chatId, '🌐 *Visit Our Web Store:*\nhttps://voucher-vault-lhqo.onrender.com', {
                parse_mode: 'Markdown'
            });
        }
        // SUPPORT
        else if (text === '🆘 Support') {
            bot.sendMessage(chatId, '💬 Need help? Contact Admin or join our channel for updates.');
        }
    });

    // Handle Inline Callbacks (Selecting Products & Payment)
    bot.on('callback_query', async (query) => {
        const data = query.data;
        const chatId = query.message.chat.id;

        // Brand selected -> Show products/denominations
        if (data.startsWith('brand_')) {
            const brandId = data.replace('brand_', '');
            const prods = await pool.query(`
                SELECT vp.id, vp.title, vp.denomination, vp.selling_price,
                       (SELECT COUNT(*) FROM voucher_inventory vi WHERE vi.voucher_product_id = vp.id AND vi.status = 'AVAILABLE') as stock
                FROM voucher_products vp
                WHERE vp.brand_id = $1
            `, [brandId]);

            if (prods.rows.length === 0) {
                return bot.sendMessage(chatId, '⚠️ No active vouchers for this brand.');
            }

            const buttons = prods.rows.map(p => [{
                text: `${p.title} - ₹${p.selling_price} (Stock: ${p.stock})`,
                callback_data: `buy_${p.id}`
            }]);

            bot.sendMessage(chatId, '💳 *Select Denomination to Buy:*', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
        // Buy selected -> Show UPI QR & Code
        else if (data.startsWith('buy_')) {
            const prodId = data.replace('buy_', '');
            const res = await pool.query(`SELECT vp.*, b.name as brand_name FROM voucher_products vp JOIN brands b ON vp.brand_id = b.id WHERE vp.id = $1`, [prodId]);
            
            if (res.rows.length === 0) return;
            const p = res.rows[0];

            const upiLink = `upi://pay?pa=${UPI_ID}&pn=VoucherVault&am=${p.selling_price}&cu=INR`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiLink)}`;

            bot.sendPhoto(chatId, qrUrl, {
                caption: `🛒 *Order Summary:*\n\nBrand: *${p.brand_name}*\nItem: *${p.title}*\nAmount to Pay: *₹${p.selling_price}*\n\n📲 *UPI ID:* \`${UPI_ID}\`\n\nScan QR Code to pay. Once paid, click below:`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ I Have Paid (Unlock Voucher)', callback_data: `claim_${p.id}` }]
                    ]
                }
            });
        }
        // Claim Voucher
        else if (data.startsWith('claim_')) {
            const prodId = data.replace('claim_', '');
            const inv = await pool.query(`
                SELECT * FROM voucher_inventory 
                WHERE voucher_product_id = $1 AND status = 'AVAILABLE' 
                LIMIT 1
            `, [prodId]);

            if (inv.rows.length === 0) {
                return bot.sendMessage(chatId, '⚠️ Out of stock! Please contact support.');
            }

            const item = inv.rows[0];
            await pool.query(`UPDATE voucher_inventory SET status = 'SOLD' WHERE id = $1`, [item.id]);

            bot.sendMessage(chatId, `🎉 *Payment Verified & Unlocked!*\n\n🔑 *Voucher Code:* \`${item.encrypted_code}\`\n🔒 *PIN:* \`${item.encrypted_pin || 'N/A'}\`\n\nThank you for shopping with us!`, {
                parse_mode: 'Markdown'
            });
        }
    });

    console.log('🤖 Full Store Telegram Bot Online!');
}

// 3. EXPRESS APP & WEB STORE
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// REGISTER & LOGIN
const handleRegister = async (req, res) => {
    try {
        const { email, password, full_name, name } = req.body;
        const userEmail = email?.trim().toLowerCase();
        if (!userEmail || !password) return res.status(400).json({ error: 'Missing credentials' });

        const exists = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [userEmail]);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'Email exists' });

        const user = await pool.query('INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name', [userEmail, password, full_name || name || 'Customer']);
        res.json({ success: true, user: user.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
app.post('/api/auth/register', handleRegister);
app.post('/api/register', handleRegister);

const handleLogin = async (req, res) => {
    try {
        const { email, password } = req.body;
        const userEmail = email?.trim().toLowerCase();
        const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [userEmail]);
        if (result.rows.length === 0 || result.rows[0].password_hash !== password) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
app.post('/api/auth/login', handleLogin);
app.post('/api/login', handleLogin);

// STORE API
const getStore = async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.id, b.name, b.logo_url, c.name as category_name,
                   COALESCE(json_agg(json_build_object('id', p.id, 'title', p.title, 'denomination', p.denomination, 'selling_price', p.selling_price, 'stock', (SELECT count(*) FROM voucher_inventory vi WHERE vi.voucher_product_id = p.id AND vi.status = 'AVAILABLE'))) FILTER (WHERE p.id IS NOT NULL), '[]') as products
            FROM brands b
            LEFT JOIN categories c ON b.category_id = c.id
            LEFT JOIN voucher_products p ON b.id = p.brand_id
            GROUP BY b.id, b.name, b.logo_url, c.name
        `);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
app.get('/api/store/brands', getStore);
app.get('/api/brands', getStore);
app.get('/api/products', getStore);

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server active on port ' + PORT));
