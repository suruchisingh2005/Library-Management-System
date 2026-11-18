# Library Book Management System

A full stack course project: a REST API and simple web page for managing a
library's books, members, loans and reservations. The main focus is
**concurrency safety**: when many members try to borrow the same book at once,
no copy is ever issued twice.

## Features

- **Per-copy tracking**: each physical copy of a book is its own row
  (`book_copies`) with a status: available, issued or reserved.
- **Safe issuing under concurrency**: loans run inside a MySQL transaction
  using row locks (`FOR UPDATE`, `SKIP LOCKED`), so simultaneous requests
  cannot take the same copy.
- **Per-member borrow limit**: a member's row is locked while a loan is
  issued, so the limit can't be bypassed by parallel requests.
- **Reservation queue**: if no copy is free, members can reserve the book.
  On return, the copy is held for the first person in the queue for 48 hours.
- **Return handling**: returning a book closes the loan, reports overdue days
  and passes the copy to the next reservation, or back to the shelf.
- **Concurrency test**: `library-api/tests/concurrency.js` fires parallel
  requests to check that the system behaves correctly.

## Tech stack

- Node.js, Express 5
- MySQL (`mysql2`)
- Plain HTML front end (`library-api/public/index.html`)

## Project structure

```
library-api/
  app.js              Express app and routes
  config/db.js        MySQL connection pool
  controllers/        books, members, loans, reservations
  routes/             route definitions
  public/index.html   front-end page
  tests/              concurrency test
library_seed.sql      database schema and seed data
*.csv                 dataset (books, authors, members, subjects, issued books)
```

## Setup

1. Install Node.js and MySQL.
2. Create a database and import `library_seed.sql`.
3. In `library-api/`, create a `.env` file:
   ```
   PORT=3000
   DB_HOST=localhost
   DB_USER=your_user
   DB_PASSWORD=your_password
   DB_NAME=your_database
   ```
4. Install and run:
   ```
   cd library-api
   npm install
   npm run dev
   ```
5. Open http://localhost:3000

## API endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/books`, `/api/books/:id` | List / get books |
| GET | `/api/members`, `/api/members/:id` | List / get members |
| POST | `/api/loans/issue` | Issue a book (`member_id`, `book_id`) |
| POST | `/api/loans/return` | Return a book (`issue_id`) |
| POST | `/api/reservations` | Reserve a book |
| GET | `/api/reservations/book/:bookId` | View a book's reservation queue |
| POST | `/api/reservations/:id/cancel` | Cancel a reservation |
| POST | `/api/reservations/expire-overdue` | Expire reservations not collected in time |
| GET | `/health` | Health check |
