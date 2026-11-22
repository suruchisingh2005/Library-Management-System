const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT member_id, name, status, borrow_limit, open_loans
       FROM member_open_loans ORDER BY member_id`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const [members] = await pool.query(
      `SELECT member_id, name, email, phone, join_date, status, borrow_limit
       FROM members WHERE member_id = ?`, [req.params.id]);
    if (members.length === 0) return res.status(404).json({ error: 'Member not found' });

    const [loans] = await pool.query(
      `SELECT i.issue_id, b.title, c.barcode, i.issue_date, i.due_date
       FROM issued_books i
       JOIN book_copies c ON c.copy_id = i.copy_id
       JOIN books b ON b.book_id = c.book_id
       WHERE i.member_id = ? AND i.return_date IS NULL
       ORDER BY i.due_date`, [req.params.id]);

    res.json({ ...members[0], open_loans: loans.length, loans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};