const router = require('express').Router();
const ctrl = require('../controllers/doctorController');
const { authenticate, requireRole } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

const upload = multer({
  dest: path.join(__dirname, '../../uploads'),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(authenticate, requireRole('doctor'));

router.get('/dashboard', ctrl.getDashboard);
router.get('/patients', ctrl.getPatients);
router.get('/patients/:patientId', ctrl.getPatientDetails);
router.get('/appointments', ctrl.getAppointments);
router.put('/appointments/:id/status', ctrl.updateAppointmentStatus);
router.get('/lab-results', ctrl.getLabResults);
router.post('/lab-results', upload.single('file'), ctrl.addLabResult);
router.get('/prescriptions', ctrl.getPrescriptions);
router.post('/prescriptions', upload.single('file'), ctrl.issuePrescription);
router.get('/prescription-orders', ctrl.getPrescriptionOrders);
router.put('/prescription-orders', ctrl.updatePrescriptionOrderStatus);
router.post('/clinical-notes', ctrl.addClinicalNote);
router.get('/schedule', ctrl.getSchedule);
router.put('/schedule', ctrl.updateSchedule);
router.get('/alerts', ctrl.getAlerts);
router.get('/notifications', ctrl.getNotifications);
router.get('/profile', ctrl.getDoctorProfile);
router.put('/profile', ctrl.updateDoctorProfile);

module.exports = router;
