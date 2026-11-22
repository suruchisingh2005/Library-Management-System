const router = require('express').Router();
const memberController = require('../controllers/memberController');

router.get('/', memberController.getAll);
router.get('/:id', memberController.getById);

module.exports = router;