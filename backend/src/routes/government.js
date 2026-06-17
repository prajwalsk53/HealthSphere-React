const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const prisma = require('../config/db');

router.use(authenticate, requireRole('government'));

router.get('/dashboard', async (req, res) => {
  try {
    const [totalPatients, criticalAlerts, appointments, activePrescriptions, totalFoods, totalDiseases] = await Promise.all([
      prisma.user.count({ where: { role: 'patient' } }),
      prisma.medicalRecord.count({ where: { status: 'critical' } }),
      prisma.appointment.count({ where: { appointmentDate: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
      prisma.prescription.count({ where: { status: 'active' } }),
      prisma.foodDatabase.count(),
      prisma.geneticDisease.count(),
    ]);
    res.json({ totalPatients, criticalAlerts, appointments, activePrescriptions, totalFoods, totalDiseases });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/analytics', async (req, res) => {
  try {
    const [conditions, monthlyTrends] = await Promise.all([
      prisma.familyHistory.groupBy({ by: ['conditionName'], _count: { id: true }, orderBy: { _count: { id: 'desc' } }, take: 10 }),
      prisma.user.groupBy({
        by: ['createdAt'],
        where: { role: 'patient' },
        _count: { id: true },
      }),
    ]);

    const conditionsFormatted = conditions.map(c => ({ condition_name: c.conditionName, count: c._count.id }));
    res.json({ conditions: conditionsFormatted, ageDistribution: [], monthlyTrends: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/alerts', async (req, res) => {
  try {
    const rows = await prisma.publicHealthAlert.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/alerts', async (req, res) => {
  try {
    const { title, message, severity, region } = req.body;
    const alert = await prisma.publicHealthAlert.create({
      data: { title, message, severity, region, issuedBy: req.user.id },
    });
    res.status(201).json(alert);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
