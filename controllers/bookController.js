const pool = require('../config/db');

exports.getAll = async (req, res) => {
  try {
    const search = `%${req.query.search || ''}%`;
    const [rows] = await pool.query(
      `SELECT b.book_id, b.title, b.isbn, a.name AS author, s.name AS subject,
              b.publication_year, v.total_copies, v.copies_available
       FROM books b
       JOIN authors a ON a.author_id = b.author_id
       JOIN subjects s ON s.subject_id = b.subject_id
       JOIN book_availability v ON v.book_id = b.book_id
       WHERE b.title LIKE ? OR a.name LIKE ?
       ORDER BY b.title
       LIMIT 50`,
      [search, search]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const [books] = await pool.query(
      `SELECT b.*, a.name AS author, s.name AS subject
       FROM books b
       JOIN authors a ON a.author_id = b.author_id
       JOIN subjects s ON s.subject_id = b.subject_id
       WHERE b.book_id = ?`,
      [req.params.id]
    );
    if (books.length === 0) return res.status(404).json({ error: 'Book not found' });

    const [copies] = await pool.query(
      `SELECT copy_id, copy_number, barcode, status
       FROM book_copies WHERE book_id = ? ORDER BY copy_number`,
      [req.params.id]
    );
    res.json({ ...books[0], copies });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};