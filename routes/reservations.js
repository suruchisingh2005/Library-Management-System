const router = require('express').Router();
const reservationController = require('../controllers/reservationController');

router.post('/', reservationController.reserve);
router.get('/book/:bookId', reservationController.queueForBook);

router.post('/:id/cancel', reservationController.cancel);
router.post('/expire-overdue', reservationController.expireOverdue);

module.exports = router;