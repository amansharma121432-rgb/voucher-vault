import os
import logging
from dotenv import load_dotenv
import psycopg2
from psycopg2.extras import RealDictCursor
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes,
)
from crypto_util import decrypt

load_dotenv()

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/vouchervault")

def get_db_connection():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)

# 1. /start command
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    welcome_text = (
        "🎟️ *Welcome to VoucherVault Telegram Shop!*\n\n"
        "⚡ Instant Gift Cards & Digital Coupons delivery with secure encryption.\n\n"
        "Select an option below to get started:"
    )
    keyboard = [
        [InlineKeyboardButton("🛍️ Browse Vouchers", callback_data="browse_categories")],
        [InlineKeyboardButton("🔍 Track / Claim Order", callback_data="track_order")],
        [InlineKeyboardButton("🌐 Open Web Store", url="http://localhost:3000")]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    if update.message:
        await update.message.reply_text(welcome_text, reply_markup=reply_markup, parse_mode="Markdown")
    elif update.callback_query:
        await update.callback_query.edit_message_text(welcome_text, reply_markup=reply_markup, parse_mode="Markdown")

# 2. Browse Catalog
async def handle_browse(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('''
            SELECT vp.id, vp.title, vp.selling_price, vp.denomination, b.name as brand_name,
                   COUNT(vi.id) FILTER (WHERE vi.status = 'AVAILABLE') as stock
            FROM voucher_products vp
            JOIN brands b ON vp.brand_id = b.id
            LEFT JOIN voucher_inventory vi ON vp.id = vi.voucher_product_id
            WHERE vp.is_active = TRUE
            GROUP BY vp.id, b.name
            ORDER BY vp.selling_price ASC;
        ''')
        products = cur.fetchall()
        cur.close()
        conn.close()

        if not products:
            await query.edit_message_text("No active vouchers found at the moment.")
            return

        text = "🔥 *Available Instant Vouchers:*\n\n"
        keyboard = []
        for p in products:
            stock_text = f"✅ In Stock: {p['stock']}" if p['stock'] > 0 else "❌ Sold Out"
            text += f"• *{p['title']}* (MRP: ₹{p['denomination']})\n  💸 Price: *₹{p['selling_price']}* | {stock_text}\n\n"
            if p['stock'] > 0:
                keyboard.append([InlineKeyboardButton(f"🛒 Buy {p['title']} - ₹{p['selling_price']}", callback_data=f"buy_{p['id']}")])

        keyboard.append([InlineKeyboardButton("🔙 Back to Main Menu", callback_data="main_menu")])
        reply_markup = InlineKeyboardMarkup(keyboard)
        await query.edit_message_text(text, reply_markup=reply_markup, parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Error: {e}")
        await query.edit_message_text(f"⚠️ Error loading catalog: {str(e)}")

# 3. Buy & Instant Deliver
async def handle_buy(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    product_id = query.data.replace("buy_", "")

    try:
        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute("SELECT title, selling_price FROM voucher_products WHERE id = %s", (product_id,))
        prod = cur.fetchone()
        if not prod:
            await query.edit_message_text("Product not found.")
            cur.close()
            conn.close()
            return

        cur.execute('''
            SELECT id, encrypted_code, encrypted_pin, serial_number
            FROM voucher_inventory
            WHERE voucher_product_id = %s AND status = 'AVAILABLE'
            LIMIT 1
            FOR UPDATE SKIP LOCKED;
        ''', (product_id,))
        inv = cur.fetchone()

        if not inv:
            await query.edit_message_text("❌ Sorry, this item is out of stock.")
            cur.close()
            conn.close()
            return

        user_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
        cur.execute('''
            INSERT INTO orders (user_id, total_amount, final_payable, status)
            VALUES (%s, %s, %s, 'COMPLETED') RETURNING id;
        ''', (user_id, prod['selling_price'], prod['selling_price']))
        order_id = cur.fetchone()['id']

        cur.execute('''
            INSERT INTO order_items (order_id, voucher_product_id, quantity, unit_price, subtotal)
            VALUES (%s, %s, 1, %s, %s) RETURNING id;
        ''', (order_id, product_id, prod['selling_price'], prod['selling_price']))
        order_item_id = cur.fetchone()['id']

        cur.execute('''
            INSERT INTO order_delivered_vouchers (order_id, order_item_id, inventory_id)
            VALUES (%s, %s, %s);
        ''', (order_id, order_item_id, inv['id']))

        cur.execute("UPDATE voucher_inventory SET status = 'SOLD' WHERE id = %s", (inv['id'],))
        conn.commit()

        code = decrypt(inv['encrypted_code'])
        pin = decrypt(inv['encrypted_pin']) if inv['encrypted_pin'] else "N/A"

        cur.close()
        conn.close()

        success_text = (
            "🎉 *Purchase Successful!*\n\n"
            f"📦 *Item:* {prod['title']}\n"
            f"🆔 *Order ID:* `{order_id}`\n\n"
            f"🔑 *Voucher Code:* `{code}`\n"
            f"🔒 *PIN:* `{pin}`\n\n"
            "_Keep this code secure! You can also track this in your Web Dashboard._"
        )
        keyboard = [
            [InlineKeyboardButton("🛍️ Buy Another Voucher", callback_data="browse_categories")],
            [InlineKeyboardButton("🔙 Main Menu", callback_data="main_menu")]
        ]
        await query.edit_message_text(success_text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

    except Exception as e:
        logger.error(f"Error buying: {e}")
        await query.edit_message_text(f"⚠️ Transaction failed: {str(e)}")

# 4. Track Order callback
async def handle_track(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    msg = (
        "🔍 *Track Your Voucher*\n\n"
        "Send your Order UUID using command:\n"
        "`/track <ORDER_ID>`\n\n"
        "Example: `/track 8dd3943e-6835-4105-98fe-e247978d3e38`"
    )
    keyboard = [[InlineKeyboardButton("🔙 Main Menu", callback_data="main_menu")]]
    await query.edit_message_text(msg, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# 5. /track <order_id>
async def track_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("⚠️ Please provide an Order ID.\nUsage: `/track <ORDER_ID>`", parse_mode="Markdown")
        return

    order_id = context.args[0].strip()
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('''
            SELECT vi.encrypted_code, vi.encrypted_pin, vp.title, o.status
            FROM orders o
            JOIN order_delivered_vouchers odv ON o.id = odv.order_id
            JOIN voucher_inventory vi ON odv.inventory_id = vi.id
            JOIN voucher_products vp ON vi.voucher_product_id = vp.id
            WHERE o.id = %s;
        ''', (order_id,))
        rows = cur.fetchall()
        cur.close()
        conn.close()

        if not rows:
            await update.message.reply_text("❌ No vouchers found for this Order ID.")
            return

        text = f"📦 *Order Lookup:* `{order_id}`\n\n"
        for r in rows:
            code = decrypt(r['encrypted_code'])
            pin = decrypt(r['encrypted_pin']) if r['encrypted_pin'] else "N/A"
            text += f"🎟️ *{r['title']}*\n• Code: `{code}`\n• PIN: `{pin}`\n\n"

        await update.message.reply_text(text, parse_mode="Markdown")
    except Exception as e:
        await update.message.reply_text(f"⚠️ Error: {str(e)}")

def main():
    bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        print("Error: TELEGRAM_BOT_TOKEN is missing in .env file!")
        return

    app = ApplicationBuilder().token(bot_token).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("track", track_cmd))
    app.add_handler(CallbackQueryHandler(handle_browse, pattern="^browse_categories$"))
    app.add_handler(CallbackQueryHandler(handle_buy, pattern="^buy_"))
    app.add_handler(CallbackQueryHandler(handle_track, pattern="^track_order$"))
    app.add_handler(CallbackQueryHandler(start, pattern="^main_menu$"))

    print("🤖 Telegram Voucher Vault Bot is starting...")
    app.run_polling()

if __name__ == '__main__':
    main()
