const router = require('express').Router();
const bookController = require('../controllers/bookController');

router.get('/', bookController.getAll);
router.get('/:id', bookController.getById);
module.exports = router;