const router = require('express').Router();
const loanController = require('../controllers/loanController');

router.post('/issue', loanController.issue);
router.post('/return', loanController.returnBook);

module.exports = router;
