// यूज़र द्वारा UTR सबमिट करने की API
app.post('/api/submit-utr', async (req, res) => {
  const { userId, voucherId, utrNumber, amount } = req.body;

  if (!utrNumber || utrNumber.trim() === '') {
    return res.status(400).json({ success: false, message: "UTR नंबर दर्ज करें!" });
  }

  try {
    const newRequest = await db.query(
      `INSERT INTO voucher_requests (user_id, voucher_id, utr_number, amount, status) 
       VALUES ($1, $2, $3, $4, 'PENDING') RETURNING *`,
      [userId, voucherId, utrNumber, amount]
    );

    res.json({ 
      success: true, 
      message: "UTR सबमिट हो गया है! Admin approval का इंतज़ार करें।", 
      request: newRequest.rows[0] 
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ success: false, message: "यह UTR नंबर पहले ही इस्तेमाल हो चुका है!" });
    }
    res.status(500).json({ success: false, message: "सर्वर त्रुटि!" });
  }
});
