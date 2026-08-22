// Send Alert to Telegram Admin when User Submits UTR
async function notifyAdminNewOrder(orderId, utr, productTitle, amount) {
  const adminChatId = process.env.ADMIN_CHAT_ID;
  const message = `🚨 <b>New Payment Verification Request</b>\n\n` +
                  `📦 <b>Product:</b> ${productTitle}\n` +
                  `💰 <b>Amount:</b> ₹${amount}\n` +
                  `🔢 <b>UTR:</b> <code>${utr}</code>\n` +
                  `🆔 <b>Order ID:</b> #${orderId}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve & Send Code", callback_data: `approve_${orderId}` },
        { text: "❌ Reject", callback_data: `reject_${orderId}` }
      ]
    ]
  };

  await bot.telegram.sendMessage(adminChatId, message, { parse_mode: 'HTML', reply_markup: keyboard });
}
