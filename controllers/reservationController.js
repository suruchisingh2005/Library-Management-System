const pool = require('../config/db');

class Reject extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

exports.reserve = async (req, res) => {
  const { member_id, book_id } = req.body;
  if (!member_id || !book_id)
    return res.status(400).json({ error: 'member_id and book_id are required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the book FIRST, so the snapshot is taken after we hold the lock
    const [b] = await conn.query('SELECT book_id FROM books WHERE book_id = ? FOR UPDATE', [book_id]);
    if (b.length === 0) throw new Reject(404, 'Book not found');

    const [m] = await conn.query('SELECT status FROM members WHERE member_id = ?', [member_id]);
    if (m.length === 0) throw new Reject(404, 'Member not found');
    if (m[0].status !== 'active') throw new Reject(403, 'Member is suspended');

    const [[{ available }]] = await conn.query(
      `SELECT COUNT(*) AS available FROM book_copies WHERE book_id = ? AND status = 'available'`,
      [book_id]);
    if (available > 0)
      throw new Reject(409, 'Copies are available. Borrow this book instead of reserving it.');

    const [[{ has_loan }]] = await conn.query(
      `SELECT COUNT(*) AS has_loan FROM issued_books i
       JOIN book_copies c ON c.copy_id = i.copy_id
       WHERE i.member_id = ? AND c.book_id = ? AND i.return_date IS NULL`,
      [member_id, book_id]);
    if (has_loan > 0) throw new Reject(409, 'You already have this book on loan');

    const [ins] = await conn.query(
      `INSERT INTO reservations (book_id, member_id, reserved_at, status)
       VALUES (?, ?, NOW(), 'waiting')`, [book_id, member_id]);

    const [[pos]] = await conn.query(
      'SELECT queue_position FROM reservation_queue WHERE reservation_id = ?', [ins.insertId]);

    await conn.commit();
    res.status(201).json({ reservation_id: ins.insertId, queue_position: pos.queue_position });
  } catch (err) {
    await conn.rollback();
    if (err instanceof Reject) return res.status(err.status).json({ error: err.message });
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ error: 'You already have a live reservation for this book' });
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
};

exports.queueForBook = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT reservation_id,queue_position, member_id, member_name, reserved_at
       FROM reservation_queue WHERE book_id = ? ORDER BY queue_position`, [req.params.bookId]);
           res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
async function closeReservation(id, newStatus, requireOverdue = false) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [r0] = await conn.query(
      'SELECT book_id FROM reservations WHERE reservation_id = ?', [id]);
    if (r0.length === 0) throw new Reject(404, 'Reservation not found');
    const bookId = r0[0].book_id;

    // same lock order as return: book first, then the reservation
    await conn.query('SELECT book_id FROM books WHERE book_id = ? FOR UPDATE', [bookId]);
    const [r] = await conn.query(
      `SELECT status, held_copy_id, (expires_at < NOW()) AS overdue
       FROM reservations WHERE reservation_id = ? FOR UPDATE`, [id]);
    if (!['waiting', 'ready'].includes(r[0].status))
      throw new Reject(409, `Reservation is already ${r[0].status}`);
    if (requireOverdue && !(r[0].status === 'ready' && r[0].overdue))
      throw new Reject(409, 'Reservation is not overdue');

    await conn.query('UPDATE reservations SET status = ? WHERE reservation_id = ?', [newStatus, id]);

    let passedTo = null;
    if (r[0].status === 'ready') {
      const copyId = r[0].held_copy_id;
      const [next] = await conn.query(
        `SELECT reservation_id, member_id FROM reservations
         WHERE book_id = ? AND status = 'waiting'
         ORDER BY reserved_at, reservation_id
         LIMIT 1 FOR UPDATE SKIP LOCKED`, [bookId]);
      if (next.length > 0) {
        await conn.query(
          `UPDATE reservations
           SET status = 'ready', held_copy_id = ?, ready_at = NOW(),
               expires_at = DATE_ADD(NOW(), INTERVAL 48 HOUR)
           WHERE reservation_id = ?`, [copyId, next[0].reservation_id]);
        passedTo = next[0];
      } else {
        await conn.query(`UPDATE book_copies SET status = 'available' WHERE copy_id = ?`, [copyId]);
      }
    }

    await conn.commit();
    return { status: newStatus, copy_passed_to: passedTo };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

exports.cancel = async (req, res) => {
  try {
    res.json(await closeReservation(req.params.id, 'cancelled'));
  } catch (err) {
    if (err instanceof Reject) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
};

exports.expireOverdue = async (req, res) => {
  try {
    const [due] = await pool.query(
      `SELECT reservation_id FROM reservations WHERE status = 'ready' AND expires_at < NOW()`);
    const results = [];
    for (const d of due) {
      try {
        const out = await closeReservation(d.reservation_id, 'expired', true);
        results.push({ reservation_id: d.reservation_id, ...out });
      } catch (err) {
        if (!(err instanceof Reject)) throw err;   // someone else already handled it
      }
    }
    res.json({ expired: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};