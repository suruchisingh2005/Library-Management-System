const pool = require('../config/db');

class Reject extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

exports.issue = async (req, res) => {
  const { member_id, book_id } = req.body;
  if (!member_id || !book_id)
    return res.status(400).json({ error: 'member_id and book_id are required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Lock this member's row, so their requests are handled one at a time
    const [m] = await conn.query(
      'SELECT status, borrow_limit FROM members WHERE member_id = ? FOR UPDATE', [member_id]);
    if (m.length === 0) throw new Reject(404, 'Member not found');
    if (m[0].status !== 'active') throw new Reject(403, 'Member is suspended');

    const [b] = await conn.query('SELECT book_id FROM books WHERE book_id = ?', [book_id]);
    if (b.length === 0) throw new Reject(404, 'Book not found');

    // 2. Borrow limit
    const [[{ open_loans }]] = await conn.query(
      'SELECT COUNT(*) AS open_loans FROM issued_books WHERE member_id = ? AND return_date IS NULL',
      [member_id]);
    if (open_loans >= m[0].borrow_limit)
      throw new Reject(409, `Borrow limit reached (${open_loans}/${m[0].borrow_limit})`);

    // 3. Pick the copy: the one held for this member, or any available copy
    let copyId, reservationId = null;
    const [held] = await conn.query(
      `SELECT reservation_id, held_copy_id FROM reservations
       WHERE book_id = ? AND member_id = ? AND status = 'ready' FOR UPDATE`,
      [book_id, member_id]);
    if (held.length > 0) {
      copyId = held[0].held_copy_id;
      reservationId = held[0].reservation_id;
    } else {
      const [c] = await conn.query(
        `SELECT copy_id FROM book_copies
         WHERE book_id = ? AND status = 'available'
         ORDER BY copy_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [book_id]);
      if (c.length === 0)
        throw new Reject(409, 'No copies available. You can reserve this book.');
      copyId = c[0].copy_id;
    }

    // 4. Issue it
    await conn.query(`UPDATE book_copies SET status = 'issued' WHERE copy_id = ?`, [copyId]);
    const [ins] = await conn.query(
      `INSERT INTO issued_books (copy_id, member_id, issue_date, due_date)
       VALUES (?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 14 DAY))`,
      [copyId, member_id]);
    if (reservationId)
      await conn.query(`UPDATE reservations SET status = 'fulfilled' WHERE reservation_id = ?`,
        [reservationId]);

    await conn.commit();
    res.status(201).json({ issue_id: ins.insertId, copy_id: copyId, due_in_days: 14 });
  } catch (err) {
    await conn.rollback();
    if (err instanceof Reject) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};
exports.returnBook = async (req, res) => {
  const { issue_id } = req.body;
  if (!issue_id) return res.status(400).json({ error: 'issue_id is required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Lock the loan
    const [loans] = await conn.query(
      `SELECT issue_id, copy_id, return_date,
              GREATEST(DATEDIFF(CURDATE(), due_date), 0) AS overdue_days
       FROM issued_books WHERE issue_id = ? FOR UPDATE`, [issue_id]);
    if (loans.length === 0) throw new Reject(404, 'Loan not found');
    if (loans[0].return_date !== null) throw new Reject(409, 'Already returned');
    const copyId = loans[0].copy_id;

    // 2. Close the loan
    await conn.query(
      'UPDATE issued_books SET return_date = CURDATE() WHERE issue_id = ? AND return_date IS NULL',
      [issue_id]);

    // 3. Who is first in the queue for this book?
    const [[copy]] = await conn.query(
      'SELECT book_id FROM book_copies WHERE copy_id = ? FOR UPDATE', [copyId]);
      await conn.query('SELECT book_id FROM books WHERE book_id = ? FOR UPDATE', [copy.book_id]);
    const [queue] = await conn.query(
      `SELECT reservation_id, member_id FROM reservations
       WHERE book_id = ? AND status = 'waiting'
       ORDER BY reserved_at, reservation_id
       LIMIT 1 FOR UPDATE SKIP LOCKED`, [copy.book_id]);

    // 4. Hand the copy to them, or put it back on the shelf
    let handedTo = null;
    if (queue.length > 0) {
      await conn.query(
        `UPDATE reservations
         SET status = 'ready', held_copy_id = ?, ready_at = NOW(),
             expires_at = DATE_ADD(NOW(), INTERVAL 48 HOUR)
         WHERE reservation_id = ?`, [copyId, queue[0].reservation_id]);
      await conn.query(`UPDATE book_copies SET status = 'reserved' WHERE copy_id = ?`, [copyId]);
      handedTo = queue[0];
    } else {
      await conn.query(`UPDATE book_copies SET status = 'available' WHERE copy_id = ?`, [copyId]);
    }

    await conn.commit();
    res.json({
      returned: true,
      overdue_days: loans[0].overdue_days,
      held_for_reservation: handedTo
    });
  } catch (err) {
    await conn.rollback();
    if (err instanceof Reject) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};