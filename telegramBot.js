import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { pool } from './db.js';
import { decrypt } from './cryptoService.js';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN || '8785909719:AAGXxoOhTNTAzb98w-4-kLbeJVO1yZFpWMo';
const UPI_ID = process.env.UPI_ID || 'merchant@upi';
const MERCHANT_NAME = 'Voucher Vault';

const bot = new TelegramBot(token, { polling: true });

console.log('🤖 Telegram Voucher Vault Bot (with Secure UPI QR Checkout) is running...');

// 1. /start command
bot.onText(/\/start/, (msg) => {
  const welcomeText = `🎟️ *Welcome to VoucherVault Telegram Shop!*\n\n⚡ Instant Gift Cards & Digital Coupons delivery.\n\nSelect an option below:`;
  bot.sendMessage(msg.chat.id, welcomeText, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛍️ Browse Vouchers', callback_data: 'browse' }],
        [{ text: '🔍 Track / Claim Order', callback_data: 'track' }]
      ]
    }
  });
});

// 2. Callbacks
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);

  if (data === 'browse') {
    try {
      const { rows } = await pool.query(`
        SELECT vp.id, vp.title, vp.selling_price, vp.denomination, b.name as brand_name,
               COUNT(vi.id) FILTER (WHERE vi.status = 'AVAILABLE') as stock
        FROM voucher_products vp
        JOIN brands b ON vp.brand_id = b.id
        LEFT JOIN voucher_inventory vi ON vp.id = vi.voucher_product_id
        WHERE vp.is_active = TRUE
        GROUP BY vp.id, b.name
        ORDER BY vp.selling_price ASC;
      `);

      let text = `🔥 *Available Instant Vouchers:*\n\n`;
      const keyboard = [];

      for (const p of rows) {
        const stockText = p.stock > 0 ? `✅ In Stock (${p.stock})` : `❌ Sold Out`;
        text += `• *${p.title}* (MRP: ₹${p.denomination})\n  💸 Price: *₹${p.selling_price}* | ${stockText}\n\n`;
        if (p.stock > 0) {
          keyboard.push([{ text: `🛒 Buy ${p.title} - ₹${p.selling_price}`, callback_data: `reserve_${p.id}` }]);
        }
      }
      keyboard.push([{ text: '🔙 Main Menu', callback_data: 'main' }]);

      bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (e) {
      bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
    }
  }

  // Reserve + Generate UPI QR (NO VOUCHER SHOWN YET)
  else if (data.startsWith('reserve_')) {
    const productId = data.replace('reserve_', '');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prodRes = await client.query('SELECT title, selling_price FROM voucher_products WHERE id = $1', [productId]);
      const prod = prodRes.rows[0];

      const lockRes = await client.query(`
        SELECT id FROM voucher_inventory
        WHERE voucher_product_id = $1 AND status = 'AVAILABLE'
        ORDER BY created_at ASC
        LIMIT 1 FOR UPDATE SKIP LOCKED
      `, [productId]);

      if (lockRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return bot.sendMessage(chatId, '❌ Out of stock!');
      }

      const invId = lockRes.rows[0].id;
      await client.query(`UPDATE voucher_inventory SET status = 'RESERVED', reserved_at = NOW() WHERE id = $1`, [invId]);

      const userId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
      const orderRes = await client.query(`
        INSERT INTO orders (user_id, total_amount, final_payable, status)
        VALUES ($1, $2, $2, 'PENDING') RETURNING id
      `, [userId, prod.selling_price]);
      const orderId = orderRes.rows[0].id;

      const itemRes = await client.query(`
        INSERT INTO order_items (order_id, voucher_product_id, quantity, unit_price, subtotal)
        VALUES ($1, $2, 1, $3, $3) RETURNING id
      `, [orderId, productId, prod.selling_price]);

      await client.query(`
        INSERT INTO order_delivered_vouchers (order_id, order_item_id, inventory_id)
        VALUES ($1, $2, $3)
      `, [orderId, itemRes.rows[0].id, invId]);

      await client.query('COMMIT');

      // Generate UPI QR Buffer
      const upiUrl = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${prod.selling_price}&cu=INR&tr=${orderId}`;
      const qrBuffer = await QRCode.toBuffer(upiUrl, { width: 350, margin: 1 });

      const caption = `💳 *Payment Required to Unlock Voucher*\n\n📦 *Item:* ${prod.title}\n💰 *Amount to Pay:* ₹${prod.selling_price}\n🆔 *Order ID:* \`${orderId}\`\n\n📌 _Scan the QR code with GPay/PhonePe/Paytm and then click below:_`;

      await bot.sendPhoto(chatId, qrBuffer, {
        caption: caption,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ I Have Paid (Unlock Voucher)', callback_data: `verify_${orderId}` }],
            [{ text: '❌ Cancel Order', callback_data: 'main' }]
          ]
        }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
    } finally {
      client.release();
    }
  }

  // Verify and Reveal Voucher
  else if (data.startsWith('verify_')) {
    const orderId = data.replace('verify_', '');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orderRes = await client.query(`SELECT id FROM orders WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [orderId]);
      if (orderRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return bot.sendMessage(chatId, '⚠️ Order not found or already completed.');
      }

      await client.query(`UPDATE orders SET status = 'COMPLETED' WHERE id = $1`, [orderId]);
      const odvRes = await client.query(`SELECT inventory_id FROM order_delivered_vouchers WHERE order_id = $1`, [orderId]);
      const invIds = odvRes.rows.map(r => r.inventory_id);
      if (invIds.length > 0) {
        await client.query(`UPDATE voucher_inventory SET status = 'SOLD' WHERE id = ANY($1)`, [invIds]);
      }
      await client.query('COMMIT');

      // Now fetch and decrypt voucher
      const queryV = `
        SELECT vi.encrypted_code, vi.encrypted_pin, vp.title
        FROM orders o
        JOIN order_delivered_vouchers odv ON o.id = odv.order_id
        JOIN voucher_inventory vi ON odv.inventory_id = vi.id
        JOIN voucher_products vp ON vi.voucher_product_id = vp.id
        WHERE o.id = $1;
      `;
      const { rows } = await pool.query(queryV, [orderId]);
      const code = decrypt(rows[0].encrypted_code);
      const pin = rows[0].encrypted_pin ? decrypt(rows[0].encrypted_pin) : 'N/A';

      const successMsg = `🎉 *Payment Confirmed & Voucher Unlocked!*\n\n📦 *Item:* ${rows[0].title}\n🆔 *Order ID:* \`${orderId}\`\n\n🔑 *Voucher Code:* \`${code}\`\n🔒 *PIN:* \`${pin}\`\n\n_Thank you for your purchase!_`;
      
      bot.sendMessage(chatId, successMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛍️ Browse More Vouchers', callback_data: 'browse' }],
            [{ text: '🔙 Main Menu', callback_data: 'main' }]
          ]
        }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      bot.sendMessage(chatId, `⚠️ Verification error: ${e.message}`);
    } finally {
      client.release();
    }
  }

  else if (data === 'track') {
    bot.sendMessage(chatId, `🔍 *Track Your Voucher*\n\nSend command:\n\`/track <ORDER_ID>\`\n\nExample: \`/track 6fad477c-ed59-4fdb-912e-88d376a97c6d\``, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🔙 Main Menu', callback_data: 'main' }]] }
    });
  }

  else if (data === 'main') {
    bot.sendMessage(chatId, `🎟️ *Voucher Vault Shop*\n\nSelect an option below:`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛍️ Browse Vouchers', callback_data: 'browse' }],
          [{ text: '🔍 Track / Claim Order', callback_data: 'track' }]
        ]
      }
    });
  }
});

// 3. /track Command
bot.onText(/\/track (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const orderId = match[1].trim();

  try {
    const { rows } = await pool.query(`
      SELECT vi.encrypted_code, vi.encrypted_pin, vp.title, o.status
      FROM orders o
      JOIN order_delivered_vouchers odv ON o.id = odv.order_id
      JOIN voucher_inventory vi ON odv.inventory_id = vi.id
      JOIN voucher_products vp ON vi.voucher_product_id = vp.id
      WHERE o.id = $1 AND o.status = 'COMPLETED'
    `, [orderId]);

    if (rows.length === 0) {
      return bot.sendMessage(chatId, '❌ No completed vouchers found for this Order ID.');
    }

    let out = `📦 *Order Lookup:* \`${orderId}\`\n\n`;
    for (const r of rows) {
      const code = decrypt(r.encrypted_code);
      const pin = r.encrypted_pin ? decrypt(r.encrypted_pin) : 'N/A';
      out += `🎟️ *${r.title}*\n• Code: \`${code}\`\n• PIN: \`${pin}\`\n\n`;
    }
    bot.sendMessage(chatId, out, { parse_mode: 'Markdown' });
  } catch (e) {
    bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
  }
});
