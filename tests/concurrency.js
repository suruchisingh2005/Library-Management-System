const pool = require('../config/db');
const BASE = 'http://localhost:3000';
let failed = 0;
const n = (x) => Number(x);

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await r.json(); } catch (e) {}
  return { status: r.status, body: json };
}

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

async function resetBook1() {
  await pool.query(`DELETE FROM issued_books WHERE copy_id IN
                    (SELECT copy_id FROM book_copies WHERE book_id = 1)`);
  await pool.query(`UPDATE book_copies SET status = 'available' WHERE book_id = 1`);
}

async function releaseMemberLoans(memberId) {
  await pool.query(`UPDATE book_copies SET status = 'available' WHERE copy_id IN
                    (SELECT copy_id FROM issued_books WHERE member_id = ? AND return_date IS NULL)`, [memberId]);
  await pool.query('DELETE FROM issued_books WHERE member_id = ? AND return_date IS NULL', [memberId]);
}

// A: 50 requests, 3 copies
async function testA() {
  console.log('\nTest A: 50 concurrent issue requests for a book with 3 copies (book 1)');
  await resetBook1();
  const [rows] = await pool.query(
    `SELECT member_id FROM member_open_loans
     WHERE status = 'active' AND open_loans <= borrow_limit - 3 AND member_id NOT IN (1,2,3)
     ORDER BY member_id`);
  const ids = rows.map(r => r.member_id);
  const res = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    post('/api/loans/issue', { member_id: ids[i % ids.length], book_id: 1 })));
  const ok = res.filter(r => r.status === 201).length;
  const noCopies = res.filter(r => r.status === 409 && /No copies/.test(r.body?.error || '')).length;
  check('exactly 3 requests succeeded', ok === 3, `${ok} succeeded`);
  check('the other 47 were rejected with "No copies available"', noCopies === 47, `${noCopies} rejected`);
  const [[av]] = await pool.query('SELECT copies_available FROM book_availability WHERE book_id = 1');
  check('copies_available ended at 0', n(av.copies_available) === 0, `available = ${av.copies_available}`);
  const [[lo]] = await pool.query(
    `SELECT COUNT(*) AS loans, COUNT(DISTINCT i.copy_id) AS copies
     FROM issued_books i JOIN book_copies c ON c.copy_id = i.copy_id
     WHERE c.book_id = 1 AND i.return_date IS NULL`);
  check('3 open loans on 3 different copies (no copy issued twice)',
    n(lo.loans) === 3 && n(lo.copies) === 3, `${lo.loans} loans, ${lo.copies} distinct copies`);
  await resetBook1();
}

// B: borrow limit under concurrency
async function testB() {
  console.log('\nTest B: member 3 (limit 5) fires 10 concurrent requests for 10 different books');
  await releaseMemberLoans(3);
  const [books] = await pool.query(
    `SELECT book_id FROM book_availability
     WHERE copies_available >= 1 AND book_id BETWEEN 2 AND 250 ORDER BY book_id LIMIT 10`);
  const res = await Promise.all(books.map(b => post('/api/loans/issue', { member_id: 3, book_id: b.book_id })));
  const ok = res.filter(r => r.status === 201).length;
  const limit = res.filter(r => r.status === 409 && /Borrow limit/.test(r.body?.error || '')).length;
  check('exactly 5 requests succeeded', ok === 5, `${ok} succeeded`);
  check('the other 5 were rejected with "Borrow limit reached"', limit === 5, `${limit} rejected`);
  const [[o]] = await pool.query('SELECT open_loans FROM member_open_loans WHERE member_id = 3');
  check('member 3 ended with exactly 5 open loans', n(o.open_loans) === 5, `${o.open_loans} open`);
  await releaseMemberLoans(3);
}

// C: member one below the limit
async function testC() {
  console.log('\nTest C: member 2 (4 of 5 used) sends 2 concurrent requests');
  const [[m]] = await pool.query('SELECT open_loans FROM member_open_loans WHERE member_id = 2');
  if (n(m.open_loans) !== 4) { console.log('SKIPPED: member 2 should start with 4 open loans. Re-run library_seed.sql.'); return; }
  const [books] = await pool.query(
    `SELECT book_id FROM book_availability
     WHERE copies_available >= 1 AND book_id BETWEEN 2 AND 250 ORDER BY book_id LIMIT 2`);
  const res = await Promise.all(books.map(b => post('/api/loans/issue', { member_id: 2, book_id: b.book_id })));
  const ok = res.filter(r => r.status === 201).length;
  const limit = res.filter(r => r.status === 409 && /Borrow limit/.test(r.body?.error || '')).length;
  check('exactly 1 request succeeded', ok === 1, `${ok} succeeded`);
  check('the other was rejected with "Borrow limit reached"', limit === 1, `${limit} rejected`);
  for (const r of res.filter(r => r.status === 201)) {   // undo the test loan
    await pool.query('DELETE FROM issued_books WHERE issue_id = ?', [r.body.issue_id]);
    await pool.query(`UPDATE book_copies SET status = 'available' WHERE copy_id = ?`, [r.body.copy_id]);
  }
}

// D: duplicate reservations
async function testD() {
  console.log('\nTest D: member 3 sends 5 concurrent reservations for the same book (book 194)');
  const [[av]] = await pool.query('SELECT copies_available FROM book_availability WHERE book_id = 194');
  if (n(av.copies_available) !== 0) { console.log('SKIPPED: book 194 should have no available copy. Re-run library_seed.sql.'); return; }
  await pool.query(`DELETE FROM reservations WHERE member_id = 3 AND book_id = 194 AND status = 'waiting'`);
  const res = await Promise.all(Array.from({ length: 5 }, () =>
    post('/api/reservations', { member_id: 3, book_id: 194 })));
  const ok = res.filter(r => r.status === 201).length;
  const dup = res.filter(r => r.status === 409).length;
  check('exactly 1 reservation was created', ok === 1, `${ok} created`);
  check('the other 4 were rejected as duplicates', dup === 4, `${dup} rejected`);
  const [[c]] = await pool.query(
    `SELECT COUNT(*) AS c FROM reservations WHERE member_id = 3 AND book_id = 194 AND status = 'waiting'`);
  check('only 1 live reservation exists in the database', n(c.c) === 1, `${c.c} found`);
  await pool.query(`DELETE FROM reservations WHERE member_id = 3 AND book_id = 194 AND status = 'waiting'`);
}

// E: queue positions
async function testE() {
  console.log('\nTest E: 10 different members join the queue for book 42 at the same moment');
  const [[av]] = await pool.query('SELECT copies_available FROM book_availability WHERE book_id = 42');
  if (n(av.copies_available) !== 0) { console.log('SKIPPED: book 42 should have no available copy. Re-run library_seed.sql.'); return; }
  const [[base]] = await pool.query('SELECT COUNT(*) AS c FROM reservation_queue WHERE book_id = 42');
  const [members] = await pool.query(
    `SELECT member_id FROM members
     WHERE status = 'active' AND member_id NOT IN (1,2,3)
       AND member_id NOT IN (SELECT member_id FROM reservations WHERE book_id = 42 AND status IN ('waiting','ready'))
       AND member_id NOT IN (SELECT i.member_id FROM issued_books i JOIN book_copies c ON c.copy_id = i.copy_id
                             WHERE c.book_id = 42 AND i.return_date IS NULL)
     ORDER BY member_id LIMIT 10`);
  const res = await Promise.all(members.map(m => post('/api/reservations', { member_id: m.member_id, book_id: 42 })));
  const ok = res.filter(r => r.status === 201);
  check('all 10 reservations were created', ok.length === 10, `${ok.length} created`);
  const positions = ok.map(r => r.body.queue_position).sort((a, b) => a - b);
  const expected = Array.from({ length: 10 }, (_, i) => n(base.c) + 1 + i);
  check('every member got a different position, in a gap-free sequence',
    JSON.stringify(positions) === JSON.stringify(expected), `positions: ${positions.join(', ')}`);
  for (const r of ok) await pool.query('DELETE FROM reservations WHERE reservation_id = ?', [r.body.reservation_id]);
}

// F: two copies returned at once (changes data, so run last)
async function testF() {
  console.log('\nTest F: both copies of book 42 are returned at the same moment');
  const [loans] = await pool.query(
    `SELECT i.issue_id FROM issued_books i JOIN book_copies c ON c.copy_id = i.copy_id
     WHERE c.book_id = 42 AND i.return_date IS NULL`);
  const [firstTwo] = await pool.query(
    'SELECT member_id FROM reservation_queue WHERE book_id = 42 ORDER BY queue_position LIMIT 2');
  if (loans.length !== 2 || firstTwo.length < 2) { console.log('SKIPPED: needs 2 open loans and 2 waiting members on book 42. Re-run library_seed.sql.'); return; }
  const res = await Promise.all(loans.map(l => post('/api/loans/return', { issue_id: l.issue_id })));
  const handed = res.map(r => r.body?.held_for_reservation?.member_id);
  check('both returns succeeded', res.every(r => r.status === 200));
  check('two different members were each handed a copy',
    handed[0] && handed[1] && handed[0] !== handed[1], `members ${handed.join(' and ')}`);
  check('they are the first two people in the queue', firstTwo.every(f => handed.includes(f.member_id)));
  const [[st]] = await pool.query(`SELECT SUM(status = 'reserved') AS reserved FROM book_copies WHERE book_id = 42`);
  check('both copies are now marked reserved', n(st.reserved) === 2, `${st.reserved} reserved`);
}

(async () => {
  try {
    await fetch(BASE + '/health');
    await testA();
    await testB();
    await testC();
    await testD();
    await testE();
    await testF();
  } catch (e) {
    console.error('\nError (is the server running on port 3000?):', e.message);
    failed++;
  } finally {
    await pool.end();
    console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
    process.exit(failed ? 1 : 0);
  }
})();