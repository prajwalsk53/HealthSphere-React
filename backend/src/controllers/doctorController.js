const prisma = require('../config/db');
const { calculateHealthScore } = require('../utils/healthAnalytics');

exports.getDashboard = async (req, res) => {
  try {
    const id = req.user.id;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const sevenDaysAgo = new Date(today); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const year = new Date().getFullYear();

    const [todaysApptsRaw, totalPatients, pendingLabs, criticalLabs, emergencyMsgsRaw, patientGroups] = await Promise.all([
      prisma.appointment.findMany({
        where: { doctorId: id, appointmentDate: { gte: today, lt: tomorrow } },
        include: { patient: { select: { id: true, name: true, dateOfBirth: true, bloodType: true, nhsId: true } } },
        orderBy: { appointmentTime: 'asc' },
      }),
      prisma.appointment.groupBy({ by: ['patientId'], where: { doctorId: id } }).then(r => r.length),
      prisma.medicalRecord.count({ where: { doctorId: id, status: 'critical' } }),
      prisma.medicalRecord.findMany({
        where: { doctorId: id, status: 'critical' },
        include: { patient: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
      prisma.message.findMany({
        where: { receiverId: id, isRead: false, isEmergency: true },
        include: { sender: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 3,
      }),
      prisma.appointment.groupBy({ by: ['patientId'], where: { doctorId: id }, _max: { appointmentDate: true } }),
    ]);

    const topPatientGroups = [...patientGroups]
      .sort((a, b) => new Date(b._max.appointmentDate) - new Date(a._max.appointmentDate))
      .slice(0, 20);
    const topPatientIds = topPatientGroups.map(g => g.patientId);

    const todayPatientIds = [...new Set(todaysApptsRaw.map(a => a.patientId))];
    const allMetricPatientIds = [...new Set([...todayPatientIds, ...topPatientIds])];

    const [metricsRaw, allergiesRaw, patientsInfo, monthlyData] = await Promise.all([
      prisma.healthMetric.findMany({ where: { userId: { in: allMetricPatientIds } }, orderBy: { recordedAt: 'desc' } }),
      prisma.allergy.findMany({ where: { userId: { in: allMetricPatientIds }, isActive: true, severity: 'severe' } }),
      prisma.user.findMany({ where: { id: { in: topPatientIds } }, select: { id: true, name: true, nhsId: true } }),
      Promise.all(Array.from({ length: 12 }, (_, m) =>
        prisma.appointment.count({ where: { doctorId: id, appointmentDate: { gte: new Date(year, m, 1), lt: new Date(year, m + 1, 1) } } })
      )),
    ]);

    const latestByUser = {};
    const weekMetricsByUser = {};
    for (const m of metricsRaw) {
      if (!latestByUser[m.userId]) latestByUser[m.userId] = m;
      if (m.recordedAt >= sevenDaysAgo) (weekMetricsByUser[m.userId] ||= []).push(m);
    }
    const allergyByUser = {};
    for (const a of allergiesRaw) (allergyByUser[a.userId] ||= []).push(a.allergen);

    const appointments = todaysApptsRaw.map(a => {
      const vit = latestByUser[a.patientId] || {};
      const bpSys = vit.systolic ?? null;
      const bpDia = vit.diastolic ?? null;
      const hr = vit.heartRate ?? null;
      const spo2 = vit.oxygenSaturation != null ? Number(vit.oxygenSaturation) : null;
      const stress = vit.stressLevel ?? null;
      const severeAllergies = (allergyByUser[a.patientId] || []).join(', ');

      let riskScore = 0;
      const riskFlags = [];
      if (bpSys != null && bpSys >= 140) { riskFlags.push('High BP'); riskScore += 30; }
      else if (bpSys != null && bpSys >= 130) { riskFlags.push('Elevated BP'); riskScore += 15; }
      if (hr != null && hr > 100) { riskFlags.push('Tachycardia'); riskScore += 25; }
      if (spo2 != null && spo2 < 93) { riskFlags.push('⚠️ Low SpO₂'); riskScore += 40; }
      if (severeAllergies) { riskFlags.push('Severe Allergy'); riskScore += 20; }
      if (stress != null && stress > 70) { riskFlags.push('High Stress'); riskScore += 10; }
      if (a.status === 'late') riskScore += 5;

      const riskLevel = riskScore >= 50 ? 'critical' : riskScore >= 25 ? 'warning' : 'low';

      return {
        ...a,
        patient_id: a.patientId,
        patient_name: a.patient.name,
        nhs_id: a.patient.nhsId,
        blood_type: a.patient.bloodType,
        date_of_birth: a.patient.dateOfBirth,
        bp_sys: bpSys, bp_dia: bpDia, heart_rate: hr, spo2,
        severe_allergies: severeAllergies,
        risk_score: riskScore, risk_flags: riskFlags, risk_level: riskLevel,
      };
    });

    const priorityQueue = appointments.filter(a => a.risk_score >= 25).sort((a, b) => b.risk_score - a.risk_score);
    const criticalPts = appointments.filter(a => a.risk_level === 'critical').length;

    const patientInfoMap = {};
    patientsInfo.forEach(p => { patientInfoMap[p.id] = p; });
    const allPatients = topPatientGroups.map(g => {
      const p = patientInfoMap[g.patientId] || {};
      const hs = calculateHealthScore(weekMetricsByUser[g.patientId] || []);
      return {
        id: g.patientId,
        name: p.name,
        nhs_id: p.nhsId,
        last_visit: g._max.appointmentDate,
        health_score: hs.score,
        score_category: hs.category,
        score_color: hs.color,
      };
    }).sort((a, b) => a.health_score - b.health_score);

    res.json({
      totalToday: appointments.length,
      totalPatients,
      pendingLabs,
      criticalPts,
      todaysAppts: appointments,
      priorityQueue,
      emergencyMsgs: emergencyMsgsRaw.map(m => ({ ...m, sender_name: m.sender.name })),
      criticalLabs: criticalLabs.map(l => ({ ...l, patient_name: l.patient.name })),
      allPatients,
      monthlyData,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getPatients = async (req, res) => {
  try {
    const { search } = req.query;
    const patientGroups = await prisma.appointment.groupBy({
      by: ['patientId'],
      where: { doctorId: req.user.id },
      _max: { appointmentDate: true },
    });
    const patientIds = patientGroups.map(g => g.patientId);
    const lastVisitMap = {};
    patientGroups.forEach(g => { lastVisitMap[g.patientId] = g._max.appointmentDate; });

    const patients = await prisma.user.findMany({
      where: {
        id: { in: patientIds },
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      select: { id: true, name: true, email: true, dateOfBirth: true, gender: true, bloodType: true, phone: true, nhsId: true, profileImage: true },
    });

    const [allergiesRaw, metricsRaw] = await Promise.all([
      prisma.allergy.findMany({ where: { userId: { in: patientIds }, isActive: true } }),
      prisma.healthMetric.findMany({ where: { userId: { in: patientIds } }, orderBy: { recordedAt: 'desc' } }),
    ]);
    const allergyByUser = {};
    for (const a of allergiesRaw) if (!allergyByUser[a.userId]) allergyByUser[a.userId] = a.allergen;
    const metricByUser = {};
    for (const m of metricsRaw) if (!metricByUser[m.userId]) metricByUser[m.userId] = m;

    res.json(patients.map(p => ({
      ...p,
      date_of_birth: p.dateOfBirth,
      blood_type: p.bloodType,
      nhs_id: p.nhsId,
      last_visit: lastVisitMap[p.id] || null,
      allergy: allergyByUser[p.id] || null,
      bp_sys: metricByUser[p.id]?.systolic ?? null,
      heart_rate: metricByUser[p.id]?.heartRate ?? null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getPatientDetails = async (req, res) => {
  try {
    const patientId = +req.params.patientId;
    const [patient, labs, prescriptions, allergies, vitals, notes] = await Promise.all([
      prisma.user.findUnique({ where: { id: patientId } }),
      prisma.medicalRecord.findMany({ where: { patientId }, orderBy: { testDate: 'desc' } }),
      prisma.prescription.findMany({ where: { patientId }, orderBy: { createdAt: 'desc' } }),
      prisma.allergy.findMany({ where: { userId: patientId } }),
      prisma.healthMetric.findMany({ where: { userId: patientId }, orderBy: { recordedAt: 'desc' }, take: 10 }),
      prisma.clinicalNote.findMany({ where: { patientId }, include: { doctor: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
    ]);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    const { password: _, ...patientData } = patient;
    res.json({ patient: patientData, labs, prescriptions, allergies, vitals, notes: notes.map(n => ({ ...n, doctor_name: n.doctor.name, doctor: undefined })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getAppointments = async (req, res) => {
  try {
    const { status, date } = req.query;
    const where = { doctorId: req.user.id };
    if (status) where.status = status;
    if (date) { const d = new Date(date); d.setHours(0,0,0,0); where.appointmentDate = d; }

    const rows = await prisma.appointment.findMany({
      where,
      include: { patient: { select: { name: true, dateOfBirth: true, bloodType: true, profileImage: true } } },
      orderBy: [{ appointmentDate: 'desc' }, { appointmentTime: 'asc' }],
    });
    res.json(rows.map(a => ({ ...a, patient_name: a.patient.name, date_of_birth: a.patient.dateOfBirth, blood_type: a.patient.bloodType })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateAppointmentStatus = async (req, res) => {
  try {
    await prisma.appointment.updateMany({
      where: { id: +req.params.id, doctorId: req.user.id },
      data: { status: req.body.status },
    });
    res.json({ message: 'Status updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getLabResults = async (req, res) => {
  try {
    const patientIds = await prisma.appointment.groupBy({ by: ['patientId'], where: { doctorId: req.user.id } }).then(r => r.map(x => x.patientId));
    const rows = await prisma.medicalRecord.findMany({
      where: { patientId: { in: patientIds } },
      include: { patient: { select: { name: true, nhsId: true } } },
      orderBy: { testDate: 'desc' },
    });
    res.json(rows.map(r => ({ ...r, patient_name: r.patient.name, nhs_id: r.patient.nhsId })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.addLabResult = async (req, res) => {
  try {
    const { patient_id, test_type, result, status, notes, test_date } = req.body;
    const filePath = req.file?.filename || null;
    const rec = await prisma.medicalRecord.create({
      data: {
        patientId: +patient_id, doctorId: req.user.id,
        testType: test_type, result, status, notes,
        testDate: test_date ? new Date(test_date) : null,
        filePath,
      },
    });
    res.status(201).json(rec);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

const ACTIVE_ORDER_STATUSES = ['pending', 'approved', 'preparing', 'dispatched'];
const COMPLETED_ORDER_STATUSES = ['delivered', 'rejected', 'cancelled'];
const ORDER_ACTION_MAP = {
  approve: 'approved',
  preparing: 'preparing',
  dispatch: 'dispatched',
  deliver: 'delivered',
  reject: 'rejected',
};

exports.getPrescriptionOrders = async (req, res) => {
  try {
    const tab = req.query.tab === 'history' ? 'history' : 'pending';
    const statuses = tab === 'pending' ? ACTIVE_ORDER_STATUSES : COMPLETED_ORDER_STATUSES;

    const [orders, pendingCount] = await Promise.all([
      prisma.prescriptionOrder.findMany({
        where: { doctorId: req.user.id, status: { in: statuses } },
        include: {
          prescription: { select: { medicationName: true, dosage: true, frequency: true, instructions: true } },
          patient: { select: { name: true, nhsId: true, dateOfBirth: true } },
        },
        orderBy: { orderedAt: 'desc' },
      }),
      prisma.prescriptionOrder.count({ where: { doctorId: req.user.id, status: { in: ACTIVE_ORDER_STATUSES } } }),
    ]);

    res.json({
      pendingCount,
      orders: orders.map(o => ({
        ...o,
        medication_name: o.prescription.medicationName,
        dosage: o.prescription.dosage,
        frequency: o.prescription.frequency,
        instructions: o.prescription.instructions,
        patient_name: o.patient.name,
        nhs_id: o.patient.nhsId,
        date_of_birth: o.patient.dateOfBirth,
        delivery_method: o.deliveryMethod,
        delivery_address: o.deliveryAddress,
        pharmacy_name: o.pharmacyName,
        patient_notes: o.patientNotes,
        doctor_notes: o.doctorNotes,
        ordered_at: o.orderedAt,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updatePrescriptionOrderStatus = async (req, res) => {
  try {
    const { action, order_id, doctor_notes, pharmacy_name } = req.body;
    const nextStatus = ORDER_ACTION_MAP[action];
    if (!nextStatus) return res.status(400).json({ error: 'Invalid action' });

    const order = await prisma.prescriptionOrder.findFirst({ where: { id: +order_id, doctorId: req.user.id } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    await prisma.prescriptionOrder.update({
      where: { id: order.id },
      data: {
        status: nextStatus,
        ...(doctor_notes ? { doctorNotes: doctor_notes } : {}),
        ...(pharmacy_name ? { pharmacyName: pharmacy_name } : {}),
      },
    });

    const messages = {
      approved: 'Order approved.',
      preparing: 'Order marked as being prepared.',
      dispatched: 'Order marked as dispatched.',
      delivered: 'Order marked as delivered.',
      rejected: 'Order rejected.',
    };
    res.json({ success: true, message: messages[nextStatus] });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getPrescriptions = async (req, res) => {
  try {
    const rows = await prisma.prescription.findMany({
      where: { doctorId: req.user.id },
      include: { patient: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows.map(p => ({ ...p, patient_name: p.patient.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.issuePrescription = async (req, res) => {
  try {
    const { patient_id, medication_name, dosage, frequency, duration, start_date, end_date, instructions } = req.body;
    const filePath = req.file?.filename || null;
    const p = await prisma.prescription.create({
      data: {
        patientId: +patient_id, doctorId: req.user.id,
        medicationName: medication_name, dosage, frequency, duration, instructions,
        startDate: start_date ? new Date(start_date) : null,
        endDate: end_date ? new Date(end_date) : null,
        filePath,
      },
    });
    res.status(201).json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.addClinicalNote = async (req, res) => {
  try {
    const { patient_id, note_type, content } = req.body;
    const note = await prisma.clinicalNote.create({
      data: { patientId: +patient_id, doctorId: req.user.id, noteType: note_type, content },
    });
    res.status(201).json(note);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getSchedule = async (req, res) => {
  try {
    const doc = await prisma.doctor.findUnique({ where: { userId: req.user.id } });
    if (!doc) return res.json([]);
    const rows = await prisma.doctorSchedule.findMany({ where: { doctorId: doc.id }, orderBy: { dayOfWeek: 'asc' } });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateSchedule = async (req, res) => {
  try {
    const { schedules } = req.body;
    const doc = await prisma.doctor.findUnique({ where: { userId: req.user.id } });
    if (!doc) return res.status(404).json({ error: 'Doctor profile not found' });
    await prisma.doctorSchedule.deleteMany({ where: { doctorId: doc.id } });
    await prisma.doctorSchedule.createMany({
      data: schedules.map(s => ({
        doctorId: doc.id,
        dayOfWeek: s.day_of_week,
        startTime: s.start_time ? new Date(`1970-01-01T${s.start_time}`) : null,
        endTime: s.end_time ? new Date(`1970-01-01T${s.end_time}`) : null,
        isAvailable: s.is_available,
      })),
    });
    res.json({ message: 'Schedule updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getAlerts = async (req, res) => {
  try {
    const rows = await prisma.healthAlert.findMany({
      where: { doctorId: req.user.id },
      include: { patient: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(rows.map(a => ({ ...a, patient_name: a.patient.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getNotifications = async (req, res) => {
  try {
    const rows = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getDoctorProfile = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { doctor: true } });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { password: _, ...data } = user;
    res.json({ ...data, ...user.doctor });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateDoctorProfile = async (req, res) => {
  try {
    const { name, phone, address, specialization, hospital, bio, availability } = req.body;
    await prisma.user.update({ where: { id: req.user.id }, data: { name, phone, address } });
    await prisma.doctor.updateMany({ where: { userId: req.user.id }, data: { specialization, hospital, bio, availability } });
    res.json({ message: 'Profile updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
