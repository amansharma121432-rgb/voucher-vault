const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const UPI_ID = process.env.UPI_ID || 'merchant@upi';

let bot;
if (token) {
    bot = new TelegramBot(token, { polling: true });
    bot.on('polling_error', (err) => console.error('Bot Polling Error:', err.message));

    bot.onText(/\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, `👋 Welcome *${msg.from.first_name || 'Customer'}*!\n\nManual Verification Store Active.\nBrowse vouchers below:`, {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    [{ text: '🛍️ Browse Vouchers' }, { text: '📦 My Orders' }]
                ],
                resize_keyboard: true
            }
        });
    });

    bot.on('message', async (msg) => {
        if (msg.text === '🛍️ Browse Vouchers') {
            const brands = await pool.query(`SELECT id, name FROM brands ORDER BY name ASC`);
            const keyboard = brands.rows.map(b => [{ text: b.name, callback_data: `brand_${b.id}` }]);
            bot.sendMessage(msg.chat.id, '🏷️ *Select a Brand:*', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    });

    // Handle Callbacks
    bot.on('callback_query', async (query) => {
        const data = query.data;
        const chatId = query.message.chat.id;

        if (data.startsWith('brand_')) {
            const brandId = data.replace('brand_', '');
            const prods = await pool.query(`
                SELECT id, title, selling_price,
                (SELECT count(*) FROM voucher_inventory WHERE voucher_product_id = vp.id AND status = 'AVAILABLE') as stock
                FROM voucher_products vp WHERE brand_id = $1
            `, [brandId]);

            const buttons = prods.rows.map(p => [{
                text: `${p.title} - ₹${p.selling_price} (Stock: ${p.stock})`,
                callback_data: `buy_${p.id}`
            }]);

            bot.sendMessage(chatId, '💳 *Select Voucher:*', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        } else if (data.startsWith('buy_')) {
            const prodId = data.replace('buy_', '');
            const res = await pool.query(`SELECT vp.*, b.name as brand_name FROM voucher_products vp JOIN brands b ON vp.brand_id = b.id WHERE vp.id = $1`, [prodId]);
            const p = res.rows[0];

            const newOrder = await pool.query(
                `INSERT INTO orders (product_id, amount, status, telegram_chat_id) VALUES ($1, $2, 'PENDING', $3) RETURNING id`,
                [p.id, p.selling_price, chatId]
            );

            const upiLink = `upi://pay?pa=${UPI_ID}&pn=VoucherVault&am=${p.selling_price}&cu=INR`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiLink)}`;

            bot.sendPhoto(chatId, qrUrl, {
                caption: `🛒 *Order #${newOrder.rows[0].id.substring(0, 8)}*\n\nBrand: *${p.brand_name}*\nItem: *${p.title}*\nPay: *₹${p.selling_price}*\n\n📲 *UPI ID:* \`${UPI_ID}\`\n\n⚠️ Pay & reply with: \`/utr ${newOrder.rows[0].id} YOUR_UTR_NUMBER\``,
                parse_mode: 'Markdown'
            });
        }
        // ADMIN APPROVAL ACTION
        else if (data.startsWith('approve_')) {
            if (ADMIN_CHAT_ID && String(chatId) !== String(ADMIN_CHAT_ID)) return;
            const orderId = data.replace('approve_', '');

            const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1 AND status = 'PENDING'`, [orderId]);
            if (orderRes.rows.length === 0) return bot.sendMessage(chatId, '❌ Order not found or already processed.');

            const order = orderRes.rows[0];
            const inv = await pool.query(`SELECT * FROM voucher_inventory WHERE voucher_product_id = $1 AND status = 'AVAILABLE' LIMIT 1`, [order.product_id]);

            if (inv.rows.length === 0) {
                return bot.sendMessage(chatId, '⚠️ Out of stock! Cannot deliver code.');
            }

            const item = inv.rows[0];
            await pool.query(`UPDATE voucher_inventory SET status = 'SOLD' WHERE id = $1`, [item.id]);
            await pool.query(`UPDATE orders SET status = 'APPROVED', delivered_code = $1, delivered_pin = $2 WHERE id = $3`, [item.encrypted_code, item.encrypted_pin, orderId]);

            // Notify User with Code
            if (order.telegram_chat_id) {
                bot.sendMessage(order.telegram_chat_id, `🎉 *Payment Approved!*\n\n🔑 *Voucher Code:* \`${item.encrypted_code}\`\n🔒 *PIN:* \`${item.encrypted_pin || 'N/A'}\`\n\nThank you for your purchase!`, { parse_mode: 'Markdown' });
            }

            bot.editMessageText(`✅ Order #${orderId.substring(0, 8)} APPROVED & Delivered!`, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
        }
        // ADMIN REJECT ACTION
        else if (data.startsWith('reject_')) {
            if (ADMIN_CHAT_ID && String(chatId) !== String(ADMIN_CHAT_ID)) return;
            const orderId = data.replace('reject_', '');

            const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1 AND status = 'PENDING'`, [orderId]);
            if (orderRes.rows.length === 0) return;

            await pool.query(`UPDATE orders SET status = 'REJECTED' WHERE id = $1`, [orderId]);

            if (orderRes.rows[0].telegram_chat_id) {
                bot.sendMessage(orderRes.rows[0].telegram_chat_id, `❌ *Payment Rejected.* Invalid UTR or amount not received. Contact support.`);
            }

            bot.editMessageText(`❌ Order #${orderId.substring(0, 8)} REJECTED.`, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
        }
    });

    // Handle /utr submit command
    bot.onText(/\/utr (.+)/, async (msg, match) => {
        const parts = match[1].trim().split(' ');
        if (parts.length < 2) {
            return bot.sendMessage(msg.chat.id, 'Format: `/utr ORDER_ID UTR_NUMBER`', { parse_mode: 'Markdown' });
        }
        const orderId = parts[0];
        const utr = parts[1];

        await pool.query(`UPDATE orders SET utr_number = $1 WHERE id = $2`, [utr, orderId]);

        bot.sendMessage(msg.chat.id, '⏳ *Payment submitted!* Admin will verify and deliver your coupon within a few minutes.', { parse_mode: 'Markdown' });

        // Forward to Admin for verification
        if (ADMIN_CHAT_ID) {
            bot.sendMessage(ADMIN_CHAT_ID, `🔔 *New Payment to Verify:*\n\nOrder ID: \`${orderId}\`\nUTR Number: \`${utr}\`\nUser: ${msg.from.first_name} (@${msg.from.username || 'N/A'})`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Approve & Send Code', callback_data: `approve_${orderId}` },
                            { text: '❌ Reject', callback_data: `reject_${orderId}` }
                        ]
                    ]
                }
            });
        }
    });
}

// 4. EXPRESS APP (API)
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Web Submit UTR
app.post('/api/orders/submit-utr', async (req, res) => {
    try {
        const { productId, utrNumber, userEmail } = req.body;
        const prod = await pool.query('SELECT * FROM voucher_products WHERE id = $1', [productId]);
        if (prod.rows.length === 0) return res.status(404).json({ error: 'Product not found' });

        const order = await pool.query(
            `INSERT INTO orders (product_id, amount, utr_number, status) VALUES ($1, $2, $3, 'PENDING') RETURNING id`,
            [productId, prod.rows[0].selling_price, utrNumber]
        );

        if (ADMIN_CHAT_ID && bot) {
            bot.sendMessage(ADMIN_CHAT_ID, `🌐 *Web Store Payment Received!*\n\nItem: ${prod.rows[0].title}\nAmount: ₹${prod.rows[0].selling_price}\nUTR: \`${utrNumber}\`\nEmail: ${userEmail || 'Guest'}\nOrder ID: \`${order.rows[0].id}\``, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Approve & Send Code', callback_data: `approve_${order.rows[0].id}` },
                            { text: '❌ Reject', callback_data: `reject_${order.rows[0].id}` }
                        ]
                    ]
                }
            });
        }

        res.json({ success: true, message: 'Payment under verification by Admin.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Auth & Brands API
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, full_name } = req.body;
        const exists = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email.toLowerCase()]);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'Email exists' });
        const user = await pool.query('INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name', [email.toLowerCase(), password, full_name]);
        res.json({ success: true, user: user.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email.toLowerCase()]);
        if (user.rows.length === 0 || user.rows[0].password_hash !== password) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ success: true, user: user.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/brands', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT b.id, b.name, b.logo_url,
                   COALESCE(json_agg(json_build_object('id', p.id, 'title', p.title, 'denomination', p.denomination, 'selling_price', p.selling_price, 'stock', (SELECT count(*) FROM voucher_inventory vi WHERE vi.voucher_product_id = p.id AND vi.status = 'AVAILABLE'))) FILTER (WHERE p.id IS NOT NULL), '[]') as products
            FROM brands b
            LEFT JOIN voucher_products p ON b.id = p.brand_id
            GROUP BY b.id, b.name, b.logo_url
        `);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Manual Verification Voucher Vault running on port ' + PORT));S
