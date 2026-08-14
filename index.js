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

// Helper to escape HTML characters safely
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

let bot;
if (token) {
    bot = new TelegramBot(token, { polling: true });

    bot.on('polling_error', (err) => {
        console.error('Bot Polling Error:', err.message);
    });

    // /start command
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const firstName = escapeHtml(msg.from.first_name || 'Customer');

        bot.sendMessage(chatId, `👋 Hello <b>${firstName}</b>!\n\nWelcome to <b>Voucher Vault</b> 🎁\nInstant & Automated Gift Cards Store.\n\nChoose an option below:`, {
            parse_mode: 'HTML',
            reply_markup: {
                keyboard: [
                    [{ text: '🛍️ Browse Vouchers' }, { text: '📦 My Orders' }],
                    [{ text: '🆘 Support' }]
                ],
                resize_keyboard: true
            }
        });
    });

    // Handle Buttons & Text Messages
    bot.on('message', async (msg) => {
        const text = msg.text;
        const chatId = msg.chat.id;

        if (!text || text.startsWith('/start') || text.startsWith('/utr')) return;

        if (text === '🛍️ Browse Vouchers') {
            try {
                const brands = await pool.query(`
                    SELECT b.id, b.name,
                           (SELECT COUNT(*) FROM voucher_inventory vi 
                            JOIN voucher_products vp ON vi.voucher_product_id = vp.id 
                            WHERE vp.brand_id = b.id AND vi.status = 'AVAILABLE') as stock
                    FROM brands b ORDER BY b.name ASC
                `);

                if (brands.rows.length === 0) {
                    return bot.sendMessage(chatId, '⚠️ Currently no brands available.');
                }

                const keyboard = brands.rows.map(b => [{
                    text: `${b.name} (${b.stock} In Stock)`,
                    callback_data: `brand_${b.id}`
                }]);

                bot.sendMessage(chatId, '🏷️ <b>Select a Brand:</b>', {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } catch (err) {
                bot.sendMessage(chatId, '❌ Error fetching store products.');
            }
        } else if (text === '📦 My Orders') {
            bot.sendMessage(chatId, '📦 You have no pending orders. Buy a voucher to see it here!');
        } else if (text === '🆘 Support') {
            bot.sendMessage(chatId, '💬 Contact Admin for any assistance or verification queries.');
        }
    });

    // Handle Inline Callbacks
    bot.on('callback_query', async (query) => {
        const data = query.data;
        const chatId = query.message.chat.id;

        if (data.startsWith('brand_')) {
            const brandId = data.replace('brand_', '');
            const prods = await pool.query(`
                SELECT vp.id, vp.title, vp.selling_price,
                       (SELECT COUNT(*) FROM voucher_inventory vi WHERE vi.voucher_product_id = vp.id AND vi.status = 'AVAILABLE') as stock
                FROM voucher_products vp
                WHERE vp.brand_id = $1
            `, [brandId]);

            if (prods.rows.length === 0) {
                return bot.sendMessage(chatId, '⚠️ No active vouchers for this brand.');
            }

            const buttons = prods.rows.map(p => [{
                text: `${p.title} - ₹${p.selling_price} (${p.stock} Available)`,
                callback_data: `buy_${p.id}`
            }]);

            bot.sendMessage(chatId, '💳 <b>Select Voucher to Buy:</b>', {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });
        } 
        else if (data.startsWith('buy_')) {
            const prodId = data.replace('buy_', '');
            const res = await pool.query(`SELECT vp.*, b.name as brand_name FROM voucher_products vp JOIN brands b ON vp.brand_id = b.id WHERE vp.id = $1`, [prodId]);
            if (res.rows.length === 0) return;
            const p = res.rows[0];

            const newOrder = await pool.query(
                `INSERT INTO orders (product_id, amount, status, telegram_chat_id) VALUES ($1, $2, 'PENDING', $3) RETURNING id`,
                [p.id, p.selling_price, chatId]
            );

            const upiLink = `upi://pay?pa=${UPI_ID}&pn=VoucherVault&am=${p.selling_price}&cu=INR`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(upiLink)}`;

            bot.sendPhoto(chatId, qrUrl, {
                caption: `🛒 <b>Order Summary:</b>\n\nBrand: <b>${escapeHtml(p.brand_name)}</b>\nItem: <b>${escapeHtml(p.title)}</b>\nPayable Amount: <b>₹${p.selling_price}</b>\n\n📲 <b>UPI ID:</b> <code>${escapeHtml(UPI_ID)}</code>\n\n⚠️ Pay & submit UTR by typing:\n<code>/utr ${newOrder.rows[0].id} YOUR_UTR_NUMBER</code>`,
                parse_mode: 'HTML'
            });
        }
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

            if (order.telegram_chat_id) {
                bot.sendMessage(order.telegram_chat_id, `🎉 <b>Payment Approved!</b>\n\n🔑 <b>Voucher Code:</b> <code>${escapeHtml(item.encrypted_code)}</code>\n🔒 <b>PIN:</b> <code>${escapeHtml(item.encrypted_pin || 'N/A')}</code>\n\nThank you for shopping with us!`, { parse_mode: 'HTML' });
            }

            bot.editMessageText(`✅ Order #${orderId.substring(0, 8)} APPROVED & Delivered!`, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
        }
        else if (data.startsWith('reject_')) {
            if (ADMIN_CHAT_ID && String(chatId) !== String(ADMIN_CHAT_ID)) return;
            const orderId = data.replace('reject_', '');

            const orderRes = await pool.query(`SELECT * FROM orders WHERE id = $1 AND status = 'PENDING'`, [orderId]);
            if (orderRes.rows.length === 0) return;

            await pool.query(`UPDATE orders SET status = 'REJECTED' WHERE id = $1`, [orderId]);

            if (orderRes.rows[0].telegram_chat_id) {
                bot.sendMessage(orderRes.rows[0].telegram_chat_id, `❌ <b>Payment Rejected.</b> Invalid UTR or amount not received. Contact support.`, { parse_mode: 'HTML' });
            }

            bot.editMessageText(`❌ Order #${orderId.substring(0, 8)} REJECTED.`, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
        }
    });

    // UTR submission
    bot.onText(/\/utr (.+)/, async (msg, match) => {
        const parts = match[1].trim().split(' ');
        if (parts.length < 2) {
            return bot.sendMessage(msg.chat.id, 'Format: <code>/utr ORDER_ID UTR_NUMBER</code>', { parse_mode: 'HTML' });
        }
        const orderId = parts[0];
        const utr = parts[1];

        try {
            await pool.query(`UPDATE orders SET utr_number = $1 WHERE id = $2`, [utr, orderId]);
            bot.sendMessage(msg.chat.id, '⏳ <b>Payment submitted!</b> Admin will verify and deliver your coupon shortly.', { parse_mode: 'HTML' });

            if (ADMIN_CHAT_ID) {
                bot.sendMessage(ADMIN_CHAT_ID, `🔔 <b>New Payment to Verify:</b>\n\nOrder ID: <code>${escapeHtml(orderId)}</code>\nUTR Number: <code>${escapeHtml(utr)}</code>\nUser: ${escapeHtml(msg.from.first_name)} (@${escapeHtml(msg.from.username || 'N/A')})`, {
                    parse_mode: 'HTML',
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
        } catch (e) {
            bot.sendMessage(msg.chat.id, '❌ Invalid Order ID or submission failed.');
        }
    });

    console.log('🤖 Telegram Bot Worker attached and active!');
}

// 3. EXPRESS APP & WEB API
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, full_name } = req.body;
        const userEmail = email?.trim().toLowerCase();
        if (!userEmail || !password) return res.status(400).json({ error: 'Missing credentials' });

        const exists = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [userEmail]);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });

        const user = await pool.query('INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name', [userEmail, password, full_name || 'Customer']);
        res.json({ success: true, user: user.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
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
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server active on port ' + PORT));
