const prisma = require('../config/db');
const mailer = require('../utils/mailer');

exports.getDashboard = async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [patients, doctors, appointments, pending, foodItems, diseases, pendingDoctors, recentUsersRaw, recentLogsRaw] = await Promise.all([
      prisma.user.count({ where: { role: 'patient' } }),
      prisma.user.count({ where: { role: 'doctor', status: 'active' } }),
      prisma.appointment.count({ where: { appointmentDate: { gte: thirtyDaysAgo } } }),
      prisma.user.count({ where: { status: 'pending' } }),
      prisma.foodDatabase.count(),
      prisma.geneticDisease.count(),
      prisma.doctor.count({ where: { hcpcVerified: false } }),
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, email: true, role: true, status: true, nhsId: true, createdAt: true } }),
      prisma.accessLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8 }),
    ]);

    // Join access logs with users
    const logUserIds = [...new Set(recentLogsRaw.map(l => l.userId).filter(Boolean))];
    const logUsers = logUserIds.length
      ? await prisma.user.findMany({ where: { id: { in: logUserIds } }, select: { id: true, name: true, role: true } })
      : [];
    const logUserMap = Object.fromEntries(logUsers.map(u => [u.id, u]));
    const recentLogs = recentLogsRaw.map(l => ({
      id: l.id,
      user_name: logUserMap[l.userId]?.name || 'Unknown',
      role: logUserMap[l.userId]?.role || '',
      action: l.action,
      ip_address: l.ipAddress,
      created_at: l.createdAt,
    }));

    res.json({ patients, doctors, appointments, pending, foodItems, diseases, pendingDoctors, recentUsers: recentUsersRaw, recentLogs });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getUsers = async (req, res) => {
  try {
    const { role, status, search } = req.query;
    const users = await prisma.user.findMany({
      where: {
        ...(role   ? { role }   : {}),
        ...(status ? { status } : {}),
        ...(search ? {
          OR: [
            { name:  { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { nhsId: { contains: search, mode: 'insensitive' } },
          ],
        } : {}),
      },
      select: {
        id: true, name: true, email: true, role: true, status: true,
        nhsId: true, createdAt: true, phone: true, dateOfBirth: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // Most-recent access log per user → last login time + IP
    const userIds = users.map(u => u.id);
    const lastLogs = userIds.length
      ? await prisma.accessLog.findMany({
          where:    { userId: { in: userIds } },
          select:   { userId: true, ipAddress: true, createdAt: true },
          orderBy:  { createdAt: 'desc' },
          distinct: ['userId'],
        })
      : [];
    const logMap = Object.fromEntries(lastLogs.map(l => [l.userId, l]));

    res.json(users.map(u => ({
      ...u,
      lastLogin: logMap[u.id]?.createdAt || null,
      lastIp:    logMap[u.id]?.ipAddress  || null,
    })));
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
    const { search, verified } = req.query;
    const rows = await prisma.user.findMany({
      where: {
        role: 'doctor',
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { email: { contains: search, mode: 'insensitive' } }] } : {}),
        ...(verified === 'true'  ? { doctor: { hcpcVerified: true  } } : {}),
        ...(verified === 'false' ? { doctor: { hcpcVerified: false } } : {}),
      },
      include: { doctor: true },
      orderBy: { createdAt: 'desc' },
    });
    // unverified first, then alphabetical
    const mapped = rows.map(u => ({
      id: u.id, name: u.name, email: u.email, status: u.status,
      nhsId: u.nhsId, createdAt: u.createdAt,
      docId: u.doctor?.id,
      specialization: u.doctor?.specialization,
      hospital: u.doctor?.hospital,
      hcpcNumber: u.doctor?.hcpcNumber,
      hcpcVerified: u.doctor?.hcpcVerified ?? false,
      rating: u.doctor?.rating,
      experienceYears: u.doctor?.experienceYears,
    }));
    mapped.sort((a, b) => a.hcpcVerified - b.hcpcVerified || a.name.localeCompare(b.name));
    res.json(mapped);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.verifyDoctor = async (req, res) => {
  try {
    const { hcpc_verified } = req.body;
    const id = +req.params.id;
    await prisma.doctor.updateMany({ where: { userId: id }, data: { hcpcVerified: hcpc_verified } });
    await prisma.user.update({ where: { id }, data: { status: hcpc_verified ? 'active' : 'pending' } });
    res.json({ message: hcpc_verified ? 'Doctor verified.' : 'Access revoked.' });
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
      where: search ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { category: { contains: search, mode: 'insensitive' } },
        ],
      } : {},
      orderBy: { name: 'asc' },
      take: 200,
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.addFoodItem = async (req, res) => {
  try {
    const {
      name, category, calories, protein, carbs, sugar, fat, fiber, sodium,
      allergens, avoid_if, vitamins, portion_size, health_rating,
    } = req.body;
    const item = await prisma.foodDatabase.create({
      data: {
        name,
        category: category || null,
        calories: calories ? +calories : null,
        protein: protein ? +protein : null,
        carbs: carbs ? +carbs : null,
        sugar: sugar ? +sugar : null,
        fat: fat ? +fat : null,
        fiber: fiber ? +fiber : null,
        sodium: sodium ? +sodium : null,
        allergens: allergens || null,
        avoidIf: avoid_if || null,
        vitamins: vitamins || null,
        portionSize: portion_size || null,
        healthRating: health_rating || 'moderate',
      },
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

exports.searchFoodAPI = async (req, res) => {
  try {
    const axios = require('axios');
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const { data } = await axios.get(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&action=process&json=1&page_size=20&fields=product_name,nutriments,categories_tags,image_url`,
      { timeout: 12000 }
    );

    const results = (data.products || [])
      .filter(p => p.product_name && p.product_name.trim())
      .slice(0, 12)
      .map(p => {
        const n = p.nutriments || {};
        const kcal = n['energy-kcal_100g'] || Math.round((n['energy_100g'] || 0) / 4.184);
        const rawCat = (p.categories_tags || []).find(t => t.startsWith('en:')) || '';
        const category = rawCat.replace(/^en:/, '').replace(/-/g, ' ');
        return {
          food_name: p.product_name.trim(),
          category: category || 'Food',
          image: p.image_url || null,
          calories_per_100g: Math.round(kcal) || 0,
          protein_g: +parseFloat(n.proteins_100g || 0).toFixed(1),
          carbs_g: +parseFloat(n.carbohydrates_100g || 0).toFixed(1),
          sugar_g: +parseFloat(n.sugars_100g || 0).toFixed(1),
          fats_g: +parseFloat(n.fat_100g || 0).toFixed(1),
          fiber_g: +parseFloat(n.fiber_100g || 0).toFixed(1),
          sodium_mg: Math.round((n.sodium_100g || 0) * 1000),
        };
      });

    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getDiseases = async (req, res) => {
  try {
    const { search } = req.query;
    const rows = await prisma.geneticDisease.findMany({
      where: search ? { name: { contains: search, mode: 'insensitive' } } : {},
      orderBy: { name: 'asc' },
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.addDisease = async (req, res) => {
  try {
    const { name, inheritance_type, symptoms, food_triggers, exercise_guidance, care_plan } = req.body;
    const d = await prisma.geneticDisease.create({
      data: { name, inheritanceType: inheritance_type, symptoms, foodTriggers: food_triggers, exerciseGuidance: exercise_guidance, carePlan: care_plan || 'standard' },
    });
    res.status(201).json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateDisease = async (req, res) => {
  try {
    const { name, inheritance_type, symptoms, food_triggers, exercise_guidance, care_plan } = req.body;
    const d = await prisma.geneticDisease.update({
      where: { id: +req.params.id },
      data: { name, inheritanceType: inheritance_type, symptoms, foodTriggers: food_triggers, exerciseGuidance: exercise_guidance, carePlan: care_plan },
    });
    res.json(d);
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteDisease = async (req, res) => {
  try {
    await prisma.geneticDisease.delete({ where: { id: +req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.searchNLM = async (req, res) => {
  try {
    const axios = require('axios');
    const { q, type, slug } = req.query;
    const NCBI = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
    const opts = { timeout: 12000 };

    if (type === 'detail') {
      const { data } = await axios.get(`${NCBI}/esummary.fcgi?db=medgen&id=${encodeURIComponent(slug)}&retmode=json`, opts);
      const uid = data.result?.uids?.[0];
      if (!uid) return res.json({ error: 'Condition not found' });
      const item = data.result[uid];
      const defs  = item.definitions?.find(d => d.source === 'MSH') || item.definitions?.[0];
      return res.json({
        name:              item.title || '',
        inheritance_label: null,
        genes:             null,
        synonyms:          item.aliases?.slice(0, 4).join(', ') || null,
        symptoms:          defs?.definition || item.definition || null,
        summary:           item.semantic_type || null,
        url:               `https://www.ncbi.nlm.nih.gov/medgen/${uid}`,
        slug:              uid,
      });
    }

    if (!q) return res.json({ results: [] });
    const { data: sd } = await axios.get(`${NCBI}/esearch.fcgi?db=medgen&term=${encodeURIComponent(q)}+[Disease/Phenotype]&retmode=json&retmax=12`, opts);
    const ids = sd.esearchresult?.idlist || [];
    if (!ids.length) return res.json({ results: [] });

    const { data: sumd } = await axios.get(`${NCBI}/esummary.fcgi?db=medgen&id=${ids.join(',')}&retmode=json`, opts);
    const uids = sumd.result?.uids || [];
    const results = uids.map(uid => {
      const item = sumd.result[uid];
      const defs  = item.definitions?.find(d => d.source === 'MSH') || item.definitions?.[0];
      return { name: item.title, snippet: defs?.definition?.slice(0, 150) || 'Click to load full details...', slug: uid };
    }).filter(r => r.name);

    res.json({ results });
  } catch (err) {
    res.json({ error: 'MedlinePlus search failed: ' + err.message });
  }
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
      smtpHost: mailer.MAIL_HOST,
      smtpPort: mailer.MAIL_PORT,
      mailFrom: mailer.MAIL_FROM,
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
