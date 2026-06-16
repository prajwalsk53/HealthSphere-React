const prisma = require('../config/db');
const mailer = require('../utils/mailer');

exports.getDashboard = async (req, res) => {
  try {
    const [patients, doctors, appointments, pending, foodItems, diseases] = await Promise.all([
      prisma.user.count({ where: { role: 'patient' } }),
      prisma.user.count({ where: { role: 'doctor', status: 'active' } }),
      prisma.appointment.count({ where: { appointmentDate: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
      prisma.user.count({ where: { status: 'pending' } }),
      prisma.foodDatabase.count(),
      prisma.geneticDisease.count(),
    ]);
    res.json({ patients, doctors, appointments, pending, foodItems, diseases });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getUsers = async (req, res) => {
  try {
    const { role, status, search } = req.query;
    const users = await prisma.user.findMany({
      where: {
        ...(role ? { role } : {}),
        ...(status ? { status } : {}),
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, name: true, email: true, role: true, status: true, nhsId: true, createdAt: true, phone: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateUserStatus = async (req, res) => {
  try {
    await prisma.user.update({ where: { id: +req.params.id }, data: { status: req.body.status } });
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteUser = async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: +req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getDoctors = async (req, res) => {
  try {
    const rows = await prisma.user.findMany({
      where: { role: 'doctor' },
      include: { doctor: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows.map(u => ({ id: u.id, name: u.name, email: u.email, status: u.status, createdAt: u.createdAt, ...u.doctor })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.verifyDoctor = async (req, res) => {
  try {
    const { hcpc_verified } = req.body;
    await prisma.doctor.updateMany({ where: { userId: +req.params.id }, data: { hcpcVerified: hcpc_verified } });
    if (hcpc_verified) await prisma.user.update({ where: { id: +req.params.id }, data: { status: 'active' } });
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getApprovals = async (req, res) => {
  try {
    const approvalRoles = ['doctor', 'government', 'pharmacy'];

    const [pendingRaw, approved, rejected] = await Promise.all([
      prisma.user.findMany({
        where: { status: 'pending', role: { in: approvalRoles } },
        include: { doctor: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.findMany({
        where: { status: 'active', role: { in: ['doctor', 'government'] } },
        include: { doctor: { select: { specialization: true, hospital: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.user.findMany({
        where: { status: 'suspended', role: { in: approvalRoles } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const pending = pendingRaw.map(u => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      phone: u.phone, nhsId: u.nhsId, createdAt: u.createdAt,
      hcpcNumber: u.doctor?.hcpcNumber,
      specialization: u.doctor?.specialization,
      hospital: u.doctor?.hospital,
      experienceYears: u.doctor?.experienceYears,
      bio: u.doctor?.bio,
    }));

    const approvedMapped = approved.map(u => ({
      id: u.id, name: u.name, email: u.email, role: u.role,
      nhsId: u.nhsId, createdAt: u.createdAt,
      specialization: u.doctor?.specialization,
      hospital: u.doctor?.hospital,
    }));

    res.json({ pending, approved: approvedMapped, rejected });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.approveUser = async (req, res) => {
  try {
    const id = +req.params.id;
    const user = await prisma.user.update({ where: { id }, data: { status: 'active' } });
    await prisma.doctor.updateMany({ where: { userId: id }, data: { hcpcVerified: true } });
    await prisma.notification.create({
      data: {
        userId: id, type: 'system',
        title: 'Account Approved — Welcome to HealthSphere',
        message: `Your ${user.role} account has been approved by the administration team. You can now sign in.`,
      },
    });
    try { await mailer.mailAccountApproved(user.email, user.name, user.role); } catch (_) {}
    res.json({ message: 'Approved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.rejectUser = async (req, res) => {
  try {
    const id = +req.params.id;
    const { reason = 'Application did not meet requirements.' } = req.body;
    const user = await prisma.user.update({ where: { id }, data: { status: 'suspended' } });
    await prisma.notification.create({
      data: {
        userId: id, type: 'system',
        title: 'Account Application — Decision',
        message: `Your application has not been approved. Reason: ${reason}. Please contact admin@healthsphere.nhs.uk for further information.`,
      },
    });
    try { await mailer.mailAccountRejected(user.email, user.name, user.role, reason); } catch (_) {}
    res.json({ message: 'Rejected' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getAnalytics = async (req, res) => {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year + 1, 0, 1);
    const monthStart = new Date(year, now.getMonth(), 1);
    const monthEnd = new Date(year, now.getMonth() + 1, 1);
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(now.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [
      totalPatients, totalDoctors, totalAppts, apptThisMonth,
      activePrescriptions, criticalCases, totalMessages, totalDocuments,
      statusGroups, recordGroups, roleGroups, medGroups,
      patientsThisYear, apptsThisYear, recentUsers,
      topDoctorsRaw, recentLogs,
    ] = await Promise.all([
      prisma.user.count({ where: { role: 'patient' } }),
      prisma.user.count({ where: { role: 'doctor', status: 'active' } }),
      prisma.appointment.count(),
      prisma.appointment.count({ where: { appointmentDate: { gte: monthStart, lt: monthEnd } } }),
      prisma.prescription.count({ where: { status: 'active' } }),
      prisma.medicalRecord.count({ where: { status: 'critical' } }),
      prisma.message.count(),
      prisma.document.count(),
      prisma.appointment.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.medicalRecord.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.user.groupBy({ by: ['role'], _count: { id: true } }),
      prisma.prescription.groupBy({ by: ['medicationName'], _count: { id: true }, orderBy: { _count: { id: 'desc' } }, take: 6 }),
      prisma.user.findMany({ where: { role: 'patient', createdAt: { gte: yearStart, lt: yearEnd } }, select: { createdAt: true } }),
      prisma.appointment.findMany({ where: { appointmentDate: { gte: yearStart, lt: yearEnd } }, select: { appointmentDate: true } }),
      prisma.user.findMany({ where: { createdAt: { gte: sevenDaysAgo } }, select: { createdAt: true } }),
      prisma.user.findMany({
        where: { role: 'doctor', status: 'active' },
        include: { doctor: { select: { specialization: true, rating: true, hospital: true } }, doctorAppts: { select: { id: true } } },
        take: 10,
      }),
      prisma.accessLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);

    const regByMonth = Array.from({ length: 12 }, (_, i) =>
      patientsThisYear.filter(u => new Date(u.createdAt).getMonth() === i).length
    );
    const apptByMonth = Array.from({ length: 12 }, (_, i) =>
      apptsThisYear.filter(a => new Date(a.appointmentDate).getMonth() === i).length
    );

    const dailyLabels = [];
    const dailyUsers = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      dailyLabels.push(d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit' }));
      dailyUsers.push(recentUsers.filter(u => {
        const ud = new Date(u.createdAt);
        return ud.getDate() === d.getDate() && ud.getMonth() === d.getMonth() && ud.getFullYear() === d.getFullYear();
      }).length);
    }

    const topDoctors = topDoctorsRaw
      .map(d => ({ name: d.name, specialization: d.doctor?.specialization, hospital: d.doctor?.hospital, rating: parseFloat(d.doctor?.rating) || 0, total_appointments: d.doctorAppts.length }))
      .sort((a, b) => b.total_appointments - a.total_appointments)
      .slice(0, 5);

    const logUserIds = [...new Set(recentLogs.map(l => l.userId).filter(Boolean))];
    const logUsers = logUserIds.length
      ? await prisma.user.findMany({ where: { id: { in: logUserIds } }, select: { id: true, name: true, role: true } })
      : [];
    const logUserMap = Object.fromEntries(logUsers.map(u => [u.id, u]));
    const recentActivity = recentLogs.map(l => ({
      user_name: logUserMap[l.userId]?.name || 'Unknown',
      role: logUserMap[l.userId]?.role || '',
      action: l.action,
      ip_address: l.ipAddress,
      created_at: l.createdAt,
    }));

    res.json({
      stats: { totalPatients, totalDoctors, totalAppts, apptThisMonth, activePrescriptions, criticalCases, totalMessages, totalDocuments },
      regByMonth,
      apptByMonth,
      statusDist: Object.fromEntries(statusGroups.map(g => [g.status, g._count.id])),
      recordDist: Object.fromEntries(recordGroups.map(g => [g.status, g._count.id])),
      roleDist: Object.fromEntries(roleGroups.map(g => [g.role, g._count.id])),
      medDist: Object.fromEntries(medGroups.map(g => [g.medicationName, g._count.id])),
      topDoctors,
      dailyLabels,
      dailyUsers,
      recentActivity,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getAccessLogs = async (req, res) => {
  try {
    const { search, role, action } = req.query;

    const logs = await prisma.accessLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      where: action ? { action: { contains: action, mode: 'insensitive' } } : {},
    });

    const userIds = [...new Set(logs.map(l => l.userId).filter(Boolean))];
    const users = await prisma.user.findMany({
      where: {
        id: { in: userIds },
        ...(role ? { role } : {}),
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
      },
      select: { id: true, name: true, email: true, role: true },
    });
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));

    const result = logs
      .map(l => {
        const u = userMap[l.userId];
        if (!u) return null;
        return { id: l.id, user_name: u.name, email: u.email, role: u.role, action: l.action, ip_address: l.ipAddress, created_at: l.createdAt, accessed_patient_id: l.accessedPatientId };
      })
      .filter(Boolean);

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getFoodDatabase = async (req, res) => {
  try {
    const { search } = req.query;
    const rows = await prisma.foodDatabase.findMany({
      where: search ? { name: { contains: search, mode: 'insensitive' } } : {},
      orderBy: { name: 'asc' },
      take: 100,
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.addFoodItem = async (req, res) => {
  try {
    const { name, calories, protein, carbs, fat, fiber, allergens, health_rating } = req.body;
    const item = await prisma.foodDatabase.create({
      data: { name, calories: calories ? +calories : null, protein: protein ? +protein : null, carbs: carbs ? +carbs : null, fat: fat ? +fat : null, fiber: fiber ? +fiber : null, allergens, healthRating: health_rating || 'good' },
    });
    res.status(201).json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteFoodItem = async (req, res) => {
  try {
    await prisma.foodDatabase.delete({ where: { id: +req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getDiseases = async (req, res) => {
  try {
    const rows = await prisma.geneticDisease.findMany({ orderBy: { name: 'asc' } });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.addDisease = async (req, res) => {
  try {
    const { name, inheritance_type, symptoms, food_triggers, exercise_guidance, care_plan } = req.body;
    const d = await prisma.geneticDisease.create({
      data: { name, inheritanceType: inheritance_type, symptoms, foodTriggers: food_triggers, exerciseGuidance: exercise_guidance, carePlan: care_plan },
    });
    res.status(201).json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteDisease = async (req, res) => {
  try {
    await prisma.geneticDisease.delete({ where: { id: +req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getSettings = async (req, res) => {
  try {
    const tables = {
      users: prisma.user.count(),
      appointments: prisma.appointment.count(),
      medical_records: prisma.medicalRecord.count(),
      allergies: prisma.allergy.count(),
      vaccinations: prisma.vaccination.count(),
      prescriptions: prisma.prescription.count(),
      diet_logs: prisma.dietLog.count(),
      health_metrics: prisma.healthMetric.count(),
      messages: prisma.message.count(),
      food_database: prisma.foodDatabase.count(),
      genetic_diseases: prisma.geneticDisease.count(),
    };
    const counts = Object.fromEntries(await Promise.all(Object.entries(tables).map(async ([k, p]) => [k, await p])));
    res.json({
      appName: 'HealthSphere',
      systemEmail: mailer.MAIL_ADMIN,
      tables: counts,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.sendTestEmail = async (req, res) => {
  try {
    const { type = 'test', to } = req.body;
    const recipient = to || mailer.MAIL_ADMIN;
    let sent = false;

    switch (type) {
      case 'test': {
        const html = mailer.hsMailTemplate(
          'Test Email ✅',
          mailer.p('This is a <strong>test email</strong> from HealthSphere.')
          + mailer.success('✅ If you received this, your email configuration is working correctly!')
          + mailer.dataTable({ 'SMTP Host': `${mailer.MAIL_HOST}:${mailer.MAIL_PORT}`, From: mailer.MAIL_FROM, 'Sent at': new Date().toLocaleString('en-GB') }),
        );
        sent = await mailer.hsSendEmail(recipient, 'Admin', 'HealthSphere — Email Test', html);
        break;
      }
      case 'welcome':
        sent = await mailer.mailPatientWelcome(recipient, 'Test Patient', 'PT123456TEST');
        break;
      case 'approval_request':
        sent = await mailer.mailAdminNewApplication('Dr. Test User', recipient, 'doctor', 'DR123456', { HCPC: 'HCPC12345678', Specialization: 'Cardiology', Hospital: 'Test Hospital' });
        break;
      case 'approved':
        sent = await mailer.mailAccountApproved(recipient, 'Dr. Test User', 'doctor');
        break;
      case 'rejected':
        sent = await mailer.mailAccountRejected(recipient, 'Test User', 'doctor', 'HCPC number could not be verified.');
        break;
      case 'appointment':
        sent = await mailer.mailAppointmentPatient(recipient, 'Test Patient', 'Emma Hall', 'Monday, 15 May 2026', '09:30', 'BP Review', 'Leicester Royal Infirmary');
        break;
      case 'emergency':
        sent = await mailer.mailEmergencyAlert(recipient, 'Test Doctor', 'Test Patient', 'PT123456', 'I am experiencing severe chest pain and shortness of breath.');
        break;
      case 'prescription':
        sent = await mailer.mailPrescriptionIssued(recipient, 'Test Patient', 'Emma Hall', 'Amlodipine', '5mg', 'Once daily (Morning)', 'Take with water for blood pressure control');
        break;
      default:
        return res.status(400).json({ error: 'Unknown email type' });
    }

    res.json({ success: sent, to: recipient });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
