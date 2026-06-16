const router = require('express').Router();
const ctrl = require('../controllers/adminController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('admin'));

router.get('/dashboard', ctrl.getDashboard);
router.get('/users', ctrl.getUsers);
router.put('/users/:id/status', ctrl.updateUserStatus);
router.delete('/users/:id', ctrl.deleteUser);
router.get('/doctors', ctrl.getDoctors);
router.put('/doctors/:id/verify', ctrl.verifyDoctor);
router.get('/approvals', ctrl.getApprovals);
router.post('/approvals/:id/approve', ctrl.approveUser);
router.post('/approvals/:id/reject', ctrl.rejectUser);
router.get('/analytics', ctrl.getAnalytics);
router.get('/access-logs', ctrl.getAccessLogs);
router.get('/food-database', ctrl.getFoodDatabase);
router.post('/food-database', ctrl.addFoodItem);
router.delete('/food-database/:id', ctrl.deleteFoodItem);
router.get('/diseases', ctrl.getDiseases);
router.post('/diseases', ctrl.addDisease);
router.delete('/diseases/:id', ctrl.deleteDisease);
router.get('/settings', ctrl.getSettings);
router.post('/test-email', ctrl.sendTestEmail);

module.exports = router;
