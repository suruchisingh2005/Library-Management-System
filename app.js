require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./config/db');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS books FROM books');
    res.json({ status: 'ok', books: rows[0].books });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/api/books', require('./routes/books'));
app.use('/api/members', require('./routes/members'));
app.use('/api/loans', require('./routes/loans'));
app.use('/api/reservations', require('./routes/reservations'));
app.use(express.static('public'));
app.listen(process.env.PORT, () =>
  console.log(`API running on http://localhost:${process.env.PORT}`));