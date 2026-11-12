// NGRM API and static frontend.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const D = require('./domain');
const L = require('./library');
const { helpers } = require('./db');
const { makeAuth, readCookie } = require('./auth');
const ai = require('./ai');
const mail = require('./mail');
const { makeFeeds } = require('./feeds');

const COOKIE = 'ngrm_session';

function createApp(db, opts = {}) {
  const h = helpers(db);
  const demoMode = opts.demoMode ?? process.env.DEMO_MODE === 'true';
  const audit = (userId, action, target) => h.run('INSERT INTO audit_log (user_id, action, target) VALUES (?, ?, ?)', userId ?? null, action, target == null ? null : String(target));
  const sendCode = opts.sendCode || ((email, code) => {
    // With an email provider configured the code is emailed; a failure is logged without the code.
    if (mail.provider()) mail.sendCode(email, code).catch((e) => console.error('Could not email a sign-in code:', e.message));
    else if (process.env.NODE_ENV !== 'production') console.log(`[dev] sign-in code for ${email}: ${code}`);
  });
  // Proof files live next to the database, outside the public folder, under random names.
  const uploadDir = opts.uploadDir || process.env.UPLOAD_DIR || path.join(path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ngrm.sqlite')), 'uploads');
  const FILE_TYPES = { 'application/pdf': ['pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'], 'image/png': ['png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))], 'image/jpeg': ['jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff] };
  const dropFile = (p) => { if (p) fs.rm(path.join(uploadDir, path.basename(p)), { force: true }, () => {}); };
  const auth = makeAuth(h, { audit, sendCode });
  const feeds = opts.feeds || makeFeeds(h);
  const app = express();

  // ---------- Basics ----------
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    // Personal data is never kept in the browser cache, so the back button cannot show it after sign-out.
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use((err, req, res, next) => (err && err.type === 'entity.too.large' ? res.status(413).json({ error: /\/file$/.test(req.path) ? 'That file is larger than 5 MB.' : 'That request is too large.' }) : err && err.type === 'entity.parse.failed' ? res.status(400).json({ error: 'The request could not be read. Refresh the page and try again.' }) : next(err)));
  app.use((req, res, next) => { req.token = readCookie(req, COOKIE); req.user = auth.userFromToken(req.token); next(); });

  const fail = (res, status, message) => res.status(status).json({ error: message });
  const need = (...roles) => (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Please sign in.');
    if (roles.length && !roles.includes(req.user.role)) return fail(res, 403, 'Your account does not have access to this.');
    // Someone on a temporary password can do nothing but choose their own.
    if (req.user.mustChange && req.path !== '/api/me/password') return fail(res, 403, 'Choose your own password first, on your Account page.');
    next();
  };
  const setCookie = (res, token) => res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: auth.SESSION_TTL_MS, path: '/' });

  // ---------- Data helpers ----------
  const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
  function consents(userId) {
    const rows = h.all('SELECT purpose, granted, is_adult, guardian_name FROM consents WHERE user_id = ? ORDER BY id', userId);
    const out = {}; for (const k of Object.keys(D.CONSENT_PURPOSES)) out[k] = false;
    out.isAdult = true; out.guardianName = null;
    for (const r of rows) { out[r.purpose] = !!r.granted; if (r.is_adult !== null) { out.isAdult = !!r.is_adult; out.guardianName = r.guardian_name; } }
    return out;
  }
  const hasConsent = (userId, purpose) => consents(userId)[purpose] === true;
  function profileRow(userId) { return h.get('SELECT * FROM profiles WHERE user_id = ?', userId); }
  function toDomain(row) {
    const vs = verifiedSkills(row.user_id, row.target_role);
    return { prog: row.programme, year: row.year, cgpa: row.cgpa, cgpaConfirmed: !!row.cgpa_confirmed, role: row.target_role, skills: parse(row.skills_json, [50, 50, 50, 50]), skillsVerified: [0, 1, 2, 3].map((i) => i in vs),
      ocean: parse(row.ocean_json, null), comm: row.comm, clarity: row.clarity };
  }
  const evidenceOf = (userId) => h.all('SELECT id, type, title, completed_on, file_name, status, verified_by, verified_at, skill_index, skill_role, skill_value, file_path IS NOT NULL AS has_file FROM evidence WHERE user_id = ? ORDER BY id', userId);
  // Skills set by a verified college assessment, for a given target role: { index: value }.
  function verifiedSkills(userId, role) {
    const out = {};
    for (const e of h.all("SELECT skill_index, skill_value FROM evidence WHERE user_id = ? AND type = 'assessment' AND status = 'verified' AND skill_role = ? AND skill_index BETWEEN 0 AND 3", userId, role)) out[e.skill_index] = e.skill_value;
    return out;
  }
  // Communication score set by a verified college assessment, or null.
  const verifiedComm = (userId) => (h.get("SELECT skill_value FROM evidence WHERE user_id = ? AND type = 'assessment' AND status = 'verified' AND skill_role = 'communication' ORDER BY id DESC LIMIT 1", userId) || {}).skill_value ?? null;
  // Look up a key only among an object's own entries, so names like "toString" are never treated as valid.
  const has = (obj, k) => typeof k === 'string' && Object.hasOwn(obj, k);
  const ruleSettings = () => h.all('SELECT * FROM rules ORDER BY rowid');
  function computeFor(userId) {
    const row = profileRow(userId); if (!row) return null;
    const p = toDomain(row), ev = evidenceOf(userId);
    return { p, ev, row, result: D.score(p, ev) };
  }
  function recsFor(userId) {
    const c = computeFor(userId); if (!c) return null;
    const list = D.recommend(c.p, c.ev, ruleSettings());
    const states = {}; for (const s of h.all('SELECT * FROM recommendation_states WHERE user_id = ?', userId)) states[s.rule_id] = s;
    return { c, list: list.map((r) => ({ ...r, state: states[r.id] || null, learn: learnFor(r.id, c.p) })) };
  }
  // Where to learn: vetted courses from the catalogue plus live searches on course sites, for the exact skill in the step.
  const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
  function learnFor(ruleId, p) {
    if (ruleId !== 'course' && ruleId !== 'communication') return null;
    const role = ruleId === 'course' ? p.role : 'communication', idx = ruleId === 'course' ? D.weakest(p) : null;
    const skill = ruleId === 'course' ? D.ROLES[p.role].skills[idx] : 'Communication skills';
    const courses = h.all('SELECT id, title, provider, url, weeks, free FROM courses WHERE role = ? AND ' + (idx === null ? 'skill_index IS NULL' : 'skill_index = ?') + ' ORDER BY id DESC LIMIT 5', ...(idx === null ? [role] : [role, idx]));
    const searches = h.all('SELECT name, url_template FROM course_sources ORDER BY id').map((s) => ({ name: s.name, url: httpsUrl(s.url_template.replace('{q}', encodeURIComponent(skill))) })).filter((s) => s.url);
    const live = feeds.forSkill(skill);
    return { skill, courses, searches, live: live.courses, liveCheckedAt: live.checkedAt, demand: ruleId === 'course' ? demandFor(p.role)[idx] : null };
  }
  // What employers on NGRM are asking for, per skill of a role, from their posts in the last 90 days.
  function demandFor(role) {
    const names = D.ROLES[role].skills, out = names.map((name) => ({ skill: name, openings: 0, posts: 0 }));
    for (const d of h.all("SELECT skills_json, openings FROM demand_posts WHERE role = ? AND created_at > datetime('now', '-90 days')", role))
      for (const k of parse(d.skills_json, [])) { const i = names.indexOf(k); if (i >= 0) { out[i].openings += d.openings; out[i].posts++; } }
    return out;
  }
  const pseudo = (id) => 'S-' + crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-only-secret-change-me').update('study:' + id).digest('hex').slice(0, 10);
  const small = (n) => (n < D.MIN_GROUP ? null : n); // null = suppressed
  // Employer-facing counts: hidden under 5, otherwise rounded to the nearest 5 so totals cannot be subtracted to find a small group.
  // A percentage is shown only when both the group it describes and the rest have 5 or more people, rounded to 5%.
  const safePct = (count, total) => (count < D.MIN_GROUP || total - count < D.MIN_GROUP ? null : Math.round(count / total * 20) * 5);
  const approx = (n) => (n < D.MIN_GROUP ? null : Math.max(D.MIN_GROUP, Math.round(n / 5) * 5));

  // Sign-up is open unless SIGNUP=off. SIGNUP_DOMAINS (comma-separated, e.g. "college.edu.in") limits student sign-up to those email domains.
  const signUpOpen = (opts.signUp ?? process.env.SIGNUP) !== 'off';
  const signUpDomains = String(opts.signUpDomains ?? process.env.SIGNUP_DOMAINS ?? '').toLowerCase().split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
  // Sign-in is by email and password. Emailed one-time codes (to confirm an address at sign-up, and as a second way in)
  // are used only when EMAIL_CODES=on, which needs an email provider.
  const emailCodes = opts.emailCodes ?? process.env.EMAIL_CODES === 'on';
  const SIGNUP_ROLES = ['student', 'mentor', 'college_admin', 'employer', 'researcher'];

  // ---------- Public ----------
  // ---------- Typed roles and programmes ----------
  // Built-in ones live in domain.js; typed ones live in the database and are loaded into the same lists.
  function loadLibrary() {
    for (const k of Object.keys(D.ROLES)) if (!D.BUILT_IN_ROLES.includes(k)) delete D.ROLES[k];
    for (const r of h.all('SELECT * FROM custom_roles')) D.ROLES[r.key] = { family: r.family, listed: !!r.listed, custom: true, needsReview: !!r.needs_review, label: r.label, skills: parse(r.skills_json, []), target: parse(r.targets_json, []), project: r.project, internship: r.internship };
    D.PROGRAMMES.splice(D.BUILT_IN_PROGRAMMES.length);
    for (const p of h.all('SELECT * FROM custom_programmes ORDER BY label')) D.PROGRAMMES.push({ id: p.id, discipline: p.discipline, listed: !!p.listed, custom: true, label: p.label, years: p.years });
  }
  loadLibrary(); D.libraryOwner = db;
  // The lists are shared by the whole process; if another database was loaded since (tests do this), reload ours.
  app.use((req, res, next) => { if (D.libraryOwner !== db) { loadLibrary(); D.libraryOwner = db; } next(); });
  // Students and visitors see the listed roles and programmes plus their own; staff see every one in use.
  function libraryFor(user) {
    if (user && user.role !== 'student') return { roles: D.ROLES, programmes: D.PROGRAMMES };
    const mine = user ? profileRow(user.id) || {} : {};
    const roles = {}; for (const k of Object.keys(D.ROLES)) if (D.ROLES[k].listed || k === mine.target_role) roles[k] = D.ROLES[k];
    return { roles, programmes: D.PROGRAMMES.filter((p) => p.listed || p.id === mine.programme) };
  }
  const typedToday = (table, userId) => h.get(`SELECT COUNT(*) AS n FROM ${table} WHERE created_by = ? AND created_at > datetime('now', '-1 day')`, userId).n;
  // Type a role: an existing one with the same name is reused, otherwise a new one is made from its role family.
  app.post('/api/library/role', need(), (req, res) => {
    const made = L.makeRole(req.body?.text);
    if (!made) return fail(res, 400, 'Type the role as you would say it, for example "Data Scientist".');
    // "Data Analysts" and "data analyst" are the same role.
    const one = (t) => L.norm(t).replace(/s$/, '');
    const same = Object.keys(D.ROLES).find((k) => one(D.ROLES[k].label) === one(made.label) || k === made.key);
    if (same) return res.json({ key: same, role: D.ROLES[same], created: false });
    if (req.user.role === 'student' && typedToday('custom_roles', req.user.id) >= 8) return fail(res, 429, 'You have added several new roles today. Choose one of them or try again tomorrow.');
    const listed = req.user.role === 'student' ? 0 : 1;
    h.run('INSERT INTO custom_roles (key, label, family, skills_json, targets_json, project, internship, needs_review, listed, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      made.key, made.label, made.family, JSON.stringify(made.skills), JSON.stringify(made.target), made.project, made.internship, made.needsReview ? 1 : 0, listed, req.user.id);
    audit(req.user.id, 'library.role_typed', made.key); loadLibrary();
    res.status(201).json({ key: made.key, role: D.ROLES[made.key], created: true });
  });
  app.post('/api/library/programme', need(), (req, res) => {
    const made = L.makeProgramme(req.body?.text);
    if (!made) return fail(res, 400, 'Type the programme as it appears on your marks card, for example "B.Sc. Physics".');
    const same = D.PROGRAMMES.find((p) => L.norm(p.label) === L.norm(made.label) || p.id === made.id);
    if (same) return res.json({ id: same.id, programme: same, created: false });
    if (req.user.role === 'student' && typedToday('custom_programmes', req.user.id) >= 8) return fail(res, 429, 'You have added several new programmes today. Choose one of them or try again tomorrow.');
    h.run('INSERT INTO custom_programmes (id, label, years, discipline, listed, created_by) VALUES (?, ?, ?, ?, ?, ?)', made.id, made.label, made.years, made.discipline, req.user.role === 'student' ? 0 : 1, req.user.id);
    audit(req.user.id, 'library.programme_typed', made.id); loadLibrary();
    res.status(201).json({ id: made.id, programme: D.programme(made.id), created: true });
  });
  // Role families a programme commonly leads to, as role names to offer.
  app.get('/api/library/suggest', need(), (req, res) => {
    const P = D.programme(String(req.query.programme || ''));
    const fams = L.suggestFor(P.discipline);
    res.json({ programme: P.label, roles: fams.map((f) => { const k = Object.keys(D.ROLES).find((x) => D.ROLES[x].family === f && D.ROLES[x].listed); return { key: k || null, label: k ? D.ROLES[k].label : L.family(f).name, fit: L.fit(P.discipline, f) }; }) });
  });
  // Admin: every typed role and programme, how much each is used, and tools to correct them.
  const roleUse = (key) => ({ students: h.get('SELECT COUNT(*) AS n FROM profiles WHERE target_role = ?', key).n, posts: h.get('SELECT COUNT(*) AS n FROM demand_posts WHERE role = ?', key).n,
    assessments: h.get("SELECT COUNT(*) AS n FROM evidence WHERE type = 'assessment' AND skill_role = ?", key).n, courses: h.get('SELECT COUNT(*) AS n FROM courses WHERE role = ?', key).n });
  app.get('/api/admin/library', need('admin'), (req, res) => res.json({
    families: L.FAMILIES.map((f) => ({ k: f.k, name: f.name })).concat([{ k: 'general', name: 'Not matched' }]),
    roles: h.all('SELECT key FROM custom_roles ORDER BY created_at DESC').map((r) => ({ key: r.key, ...D.ROLES[r.key], use: roleUse(r.key) })),
    programmes: h.all('SELECT id FROM custom_programmes ORDER BY created_at DESC').map((p) => ({ ...D.programme(p.id), students: h.get('SELECT COUNT(*) AS n FROM profiles WHERE programme = ?', p.id).n })),
  }));
  app.put('/api/admin/library/roles/:key', need('admin'), (req, res) => {
    const cur = h.get('SELECT * FROM custom_roles WHERE key = ?', req.params.key); if (!cur) return fail(res, 404, 'Not found.');
    const b = req.body || {}, label = b.label === undefined ? cur.label : L.clean(b.label);
    if (!label) return fail(res, 400, 'Give the role a name.');
    if (Object.keys(D.ROLES).some((k) => k !== cur.key && L.norm(D.ROLES[k].label) === L.norm(label))) return fail(res, 409, 'Another role already has that name.');
    let skills = parse(cur.skills_json, []), target = parse(cur.targets_json, []);
    if (b.skills !== undefined) {
      const next = (Array.isArray(b.skills) ? b.skills : []).map((x) => L.clean(x, 60));
      if (next.length !== 4 || next.some((x) => !x) || new Set(next.map(L.norm)).size !== 4) return fail(res, 400, 'Give four different skills.');
      if (JSON.stringify(next) !== JSON.stringify(skills) && roleUse(cur.key).assessments) return fail(res, 409, 'Students have already been assessed on this role’s skills, so the skills can no longer be changed. You can still rename the role.');
      skills = next;
    }
    if (b.target !== undefined) {
      const t = (Array.isArray(b.target) ? b.target : []).map(Number);
      if (t.length !== 4 || t.some((x) => !Number.isInteger(x) || x < 40 || x > 90)) return fail(res, 400, 'Each target level must be a whole number from 40 to 90.');
      target = t;
    }
    h.run('UPDATE custom_roles SET label = ?, skills_json = ?, targets_json = ?, listed = ?, needs_review = ? WHERE key = ?', label, JSON.stringify(skills), JSON.stringify(target),
      b.listed === undefined ? cur.listed : b.listed ? 1 : 0, b.skills !== undefined ? 0 : cur.needs_review, cur.key);
    audit(req.user.id, 'admin.role_edited', cur.key); loadLibrary(); res.json({ key: cur.key, ...D.ROLES[cur.key] });
  });
  app.delete('/api/admin/library/roles/:key', need('admin'), (req, res) => {
    if (!h.get('SELECT 1 FROM custom_roles WHERE key = ?', req.params.key)) return fail(res, 404, 'Not found.');
    const u = roleUse(req.params.key);
    if (u.students || u.posts || u.courses) return fail(res, 409, `This role is in use (${u.students} students, ${u.posts} employer posts, ${u.courses} courses), so it cannot be removed. You can rename or unlist it.`);
    h.run('DELETE FROM custom_roles WHERE key = ?', req.params.key); audit(req.user.id, 'admin.role_removed', req.params.key); loadLibrary(); res.json({ ok: true });
  });
  app.put('/api/admin/library/programmes/:id', need('admin'), (req, res) => {
    const cur = h.get('SELECT * FROM custom_programmes WHERE id = ?', req.params.id); if (!cur) return fail(res, 404, 'Not found.');
    const b = req.body || {}, label = b.label === undefined ? cur.label : L.clean(b.label, 80), years = b.years === undefined ? cur.years : Number(b.years);
    if (!label) return fail(res, 400, 'Give the programme a name.');
    if (!Number.isInteger(years) || years < 1 || years > 6) return fail(res, 400, 'Years must be a whole number from 1 to 6.');
    if (D.PROGRAMMES.some((p) => p.id !== cur.id && L.norm(p.label) === L.norm(label))) return fail(res, 409, 'Another programme already has that name.');
    const d = L.disciplineOf(label);
    h.run('UPDATE custom_programmes SET label = ?, years = ?, discipline = ?, listed = ? WHERE id = ?', label, years, d ? d.k : 'general', b.listed === undefined ? cur.listed : b.listed ? 1 : 0, cur.id);
    h.run('UPDATE profiles SET year = MIN(year, ?) WHERE programme = ?', years, cur.id);
    audit(req.user.id, 'admin.programme_edited', cur.id); loadLibrary(); res.json(D.programme(cur.id));
  });
  app.delete('/api/admin/library/programmes/:id', need('admin'), (req, res) => {
    if (!h.get('SELECT 1 FROM custom_programmes WHERE id = ?', req.params.id)) return fail(res, 404, 'Not found.');
    const n = h.get('SELECT COUNT(*) AS n FROM profiles WHERE programme = ?', req.params.id).n;
    if (n) return fail(res, 409, `${n} ${n === 1 ? 'student is' : 'students are'} on this programme, so it cannot be removed. You can rename or unlist it.`);
    h.run('DELETE FROM custom_programmes WHERE id = ?', req.params.id); audit(req.user.id, 'admin.programme_removed', req.params.id); loadLibrary(); res.json({ ok: true });
  });

  app.get('/api/meta', (req, res) => res.json({
    formulaVersion: D.FORMULA_VERSION, minGroup: D.MIN_GROUP, factors: D.FACTORS, ...libraryFor(req.user), fitLabels: L.FIT_LABEL,
    evidenceTypes: D.EVIDENCE_TYPES, slots: D.SLOTS, consentPurposes: D.CONSENT_PURPOSES, demoMode, signUp: signUpOpen, emailCodes,
    // Who runs this pilot and whom to contact about personal data (shown on the privacy notice).
    operator: { name: String(process.env.ORG_NAME || '').slice(0, 120) || null, contact: String(process.env.PRIVACY_CONTACT || '').slice(0, 160) || null },
  }));

  const ORG_ROLES = { student: 'institution', mentor: 'institution', college_admin: 'institution', employer: 'employer' };
  const mailNotice = opts.sendNotice || ((to, subject, text) => { if (mail.provider()) mail.sendNotice(to, subject, text).catch((e) => console.error('Could not send an email:', e.message)); });

  // ---------- Auth ----------
  // Per-address limit too, so one sender cannot flood many inboxes with codes (30 an hour).
  const ipHits = new Map();
  function ipLimited(req, res, kind = 'code', max = 30) {
    const now = Date.now(), ip = kind + ':' + (req.ip || 'unknown');
    const hits = (ipHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (hits.length >= max) { fail(res, 429, kind === 'code' ? 'Too many sign-in codes asked for from this network. Try again in an hour.' : 'Too many accounts created from this network in the last hour. Try again later.'); return true; }
    hits.push(now); ipHits.set(ip, hits);
    if (ipHits.size > 10000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < 60 * 60 * 1000)) ipHits.delete(k);
    return false;
  }
  // Sign-up. Anyone can ask; the emailed code proves the address. Students get an account at once,
  // mentors, placement cells, employers and researchers wait for an admin, and admins are never created this way.
  app.get('/api/auth/sign-up-options', (req, res) => res.json({ open: signUpOpen, domains: signUpDomains,
    institutions: signUpOpen ? h.all('SELECT id, name, city FROM institutions WHERE pending = 0 ORDER BY name') : [] }));
  app.post('/api/auth/sign-up', (req, res) => {
    if (!signUpOpen) return fail(res, 403, 'Sign-up is closed. Ask your college or the NGRM team for an account.');
    const b = req.body || {}, name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 120), email = String(b.email || '').trim().toLowerCase(), role = String(b.role || '');
    if (name.length < 2) return fail(res, 400, 'Enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail(res, 400, 'Enter a valid email address.');
    if (!SIGNUP_ROLES.includes(role)) return fail(res, 400, 'Choose who you are signing up as.');
    let institutionId = null, orgName = null, newCollege = null;
    const withCollege = () => { if (newCollege) { institutionId = Number(h.run('INSERT INTO institutions (name, city, is_sample, pending) VALUES (?, ?, 0, 1)', newCollege.name, newCollege.city).lastInsertRowid); audit(null, 'auth.college_typed', institutionId); } return institutionId; };
    if (ORG_ROLES[role] === 'institution') {
      // Pick a listed college or type one. A typed college that is new is added as "to be confirmed" by the admin.
      let inst = h.get('SELECT id FROM institutions WHERE id = ?', Number(b.institutionId) || 0);
      const typed = L.clean(b.institutionName, 120);
      if (!inst && typed) inst = h.all('SELECT id, name FROM institutions').find((i) => L.norm(i.name) === L.norm(typed) || L.norm(i.name) === L.norm(typed.split(',')[0]));
      if (!inst && !typed) return fail(res, 400, 'Choose your college, or type its name.');
      newCollege = inst ? null : { name: typed, city: L.clean(b.institutionCity, 60) || 'City not given' };
      institutionId = inst ? inst.id : null;
    }
    if (role === 'employer') { orgName = String(b.orgName || '').trim().replace(/\s+/g, ' ').slice(0, 160); if (orgName.length < 2) return fail(res, 400, 'Enter your company name.'); }
    if (role === 'student' && signUpDomains.length && !signUpDomains.some((d) => email.endsWith('@' + d) || email.endsWith('.' + d)))
      return fail(res, 400, 'Students sign up with their college email (' + signUpDomains.map((d) => '@' + d).join(', ') + ').');
    if (emailCodes) {
      if (ipLimited(req, res)) return;
      const bad = auth.passwordProblem(b.password, email); if (bad) return fail(res, 400, bad);
      const r = auth.signUpStart({ name, email, role, institutionId: withCollege(), orgName, password: b.password });
      if (r.error) return fail(res, r.status, r.error);
      return res.json(r);
    }
    // Without codes the account is made at once. A whole college lab may share one address, so the limit is generous.
    if (ipLimited(req, res, 'signup', 120)) return;
    const bad = auth.passwordProblem(b.password, email); if (bad) return fail(res, 400, bad);
    if (h.get('SELECT 1 FROM users WHERE email = ?', email)) return fail(res, 409, 'This email already has an account. Sign in instead.');
    const r = auth.signUpDirect({ name, email, role, institutionId: withCollege(), orgName, password: b.password });
    if (r.error) return fail(res, r.status, r.error);
    if (r.pending) return res.json({ pending: true });
    setCookie(res, r.token); res.json({ user: { id: r.user.id, name: r.user.name, role: r.user.role } });
  });
  app.post('/api/auth/sign-up/verify', (req, res) => {
    if (!emailCodes) return fail(res, 404, 'Not available.');
    const r = auth.signUpVerify(req.body?.email, req.body?.code);
    if (r.error) return fail(res, 400, r.error);
    if (r.pending) return res.json({ pending: true });
    setCookie(res, r.token); res.json({ user: { id: r.user.id, name: r.user.name, role: r.user.role } });
  });
  app.post('/api/auth/request-code', (req, res) => {
    if (!emailCodes) return fail(res, 404, 'Sign in with your email and password.');
    if (ipLimited(req, res)) return;
    const email = String(req.body?.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail(res, 400, 'Enter a valid email address.');
    const r = auth.requestCode(email);
    if (r.error) return fail(res, r.status, r.error);
    res.json(r);
  });
  app.post('/api/auth/verify', (req, res) => {
    if (!emailCodes) return fail(res, 404, 'Sign in with your email and password.');
    const r = auth.verifyCode(req.body?.email, req.body?.code);
    if (r.error) return fail(res, 400, r.error);
    setCookie(res, r.token); res.json({ user: { id: r.user.id, name: r.user.name, role: r.user.role } });
  });
  // Sign in with a password instead of a code (for people who have set one).
  app.post('/api/auth/password', (req, res) => {
    const r = auth.signInWithPassword(req.body?.email, req.body?.password);
    // Said only to someone who knows the password they chose, so it gives nothing away to anyone else.
    if (r.error && r.status === 400 && auth.waitingWith(req.body?.email, req.body?.password)) return fail(res, 403, 'Your email is confirmed and your account is waiting for approval by the NGRM admin. You will be able to sign in once it is approved.');
    if (r.error) return fail(res, r.status, r.error);
    setCookie(res, r.token); res.json({ user: { id: r.user.id, name: r.user.name, role: r.user.role }, mustChange: auth.mustChange(r.user.id) });
  });
  // Set or change your own password. Changing one needs the current password, unless you just signed in
  // with an emailed code: that is how a forgotten password is reset.
  app.post('/api/me/password', need(), (req, res) => {
    if (auth.hasPassword(req.user.id) && req.user.via !== 'code' && !req.user.mustChange && !auth.checkPassword(req.user.id, req.body?.current))
      return fail(res, 400, 'Your current password is not right. Forgot it? Sign out, sign in with an emailed code, and set a new one.');
    const r = auth.setPassword(req.user, req.body?.password, req.token);
    if (r.error) return fail(res, 400, r.error);
    res.json({ ok: true });
  });
  app.get('/api/auth/demo-users', (req, res) => {
    if (!demoMode) return fail(res, 404, 'Not available.');
    res.json(h.all("SELECT u.email, u.name, u.role FROM users u WHERE u.email LIKE '%@demo.ngrm.in' ORDER BY CASE u.role WHEN 'student' THEN 1 WHEN 'mentor' THEN 2 WHEN 'college_admin' THEN 3 WHEN 'employer' THEN 4 WHEN 'researcher' THEN 5 ELSE 6 END"));
  });
  app.post('/api/auth/demo', (req, res) => {
    if (!demoMode) return fail(res, 404, 'Not available.');
    const u = h.get("SELECT * FROM users WHERE email = ? AND email LIKE '%@demo.ngrm.in'", String(req.body?.email || ''));
    if (!u) return fail(res, 400, 'Unknown demo account.');
    setCookie(res, auth.startSession(u.id)); res.json({ user: { id: u.id, name: u.name, role: u.role } });
  });
  app.post('/api/auth/sign-out', (req, res) => { auth.endSession(req.token); res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    const u = req.user;
    const inst = u.institution_id ? h.get('SELECT name, city FROM institutions WHERE id = ?', u.institution_id) : null;
    const emp = u.employer_id ? h.get('SELECT name FROM employers WHERE id = ?', u.employer_id) : null;
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, institution: inst, employer: emp, hasPassword: auth.hasPassword(u.id), signedInWith: u.via, mustChangePassword: !!u.mustChange }, consents: u.role === 'student' ? consents(u.id) : undefined });
  });

  // ---------- Student: consent ----------
  app.get('/api/me/consents', need('student'), (req, res) => res.json(consents(req.user.id)));
  app.post('/api/me/consents', need('student'), (req, res) => {
    const purposes = req.body?.purposes && typeof req.body.purposes === 'object' ? req.body.purposes : {};
    const keys = Object.keys(purposes).filter((k) => has(D.CONSENT_PURPOSES, k));
    if (!keys.length) return fail(res, 400, 'Choose at least one purpose.');
    // If the request does not say, keep the age status and guardian already on record.
    const prev = consents(req.user.id);
    const isAdult = req.body?.isAdult === undefined ? prev.isAdult : req.body.isAdult !== false;
    const guardian = String(req.body?.guardianName ?? (req.body?.isAdult === undefined ? prev.guardianName || '' : '')).trim().slice(0, 120);
    if (!isAdult && keys.some((k) => purposes[k]) && !guardian) return fail(res, 400, 'Students under 18 need a parent or guardian’s consent. Add their name.');
    h.tx(() => { for (const k of keys) h.run('INSERT INTO consents (user_id, purpose, granted, is_adult, guardian_name) VALUES (?, ?, ?, ?, ?)', req.user.id, k, purposes[k] ? 1 : 0, isAdult ? 1 : 0, isAdult ? null : guardian); });
    // The introductions consent and the opt-in switch are the same choice, so keep them in step.
    if (keys.includes('introductions')) h.run('UPDATE profiles SET opt_in_intros = ? WHERE user_id = ?', purposes.introductions ? 1 : 0, req.user.id);
    if (purposes.psychometric === false) scrubPsychometric(req.user.id);
    if (purposes.ai_wording === false) h.run('UPDATE recommendation_states SET ai_text = NULL, ai_source_hash = NULL WHERE user_id = ?', req.user.id);
    audit(req.user.id, 'consent.updated', keys.map((k) => k + '=' + (purposes[k] ? 1 : 0)).join(','));
    res.json(consents(req.user.id));
  });
  const needConsent = (purpose) => (req, res, next) => (hasConsent(req.user.id, purpose) ? next() : fail(res, 403, 'consent_required:' + purpose));

  // ---------- Student: profile and score ----------
  const inWords = (row) => ({ goal: row.goal || '', interests: row.interests || '', cities: row.cities || '', ownSkills: parse(row.own_skills_json, []) });
  const cityList = (row) => String(row.cities || '').split(/[,;/]| and /i).map((x) => L.norm(x)).filter((x) => x.length >= 2);
  // Kinds of work that match what the student wrote about their goal and interests, offered as role ideas.
  function interestRoles(row, p) {
    const out = [], seen = new Set([(D.ROLES[p.role] || {}).family]);
    for (const chunk of [row.goal].concat(String(row.interests || '').split(/[,;]/)).map((x) => String(x || '').trim()).filter(Boolean)) {
      const f = L.familyOf(chunk); if (f.k === 'general' || seen.has(f.k)) continue; seen.add(f.k);
      const k = Object.keys(D.ROLES).find((x) => D.ROLES[x].family === f.k && D.ROLES[x].listed);
      out.push({ label: k ? D.ROLES[k].label : f.name, from: chunk.slice(0, 60) });
    }
    return out.slice(0, 4);
  }
  const ownSteps = (userId) => h.all('SELECT id, title, slot, done FROM own_steps WHERE user_id = ? ORDER BY id', userId).map((s) => ({ ...s, done: !!s.done }));
  // Steps the student types into their own plan.
  app.post('/api/me/steps', need('student'), needConsent('profile'), (req, res) => {
    const title = L.clean(req.body?.title, 120), slot = D.SLOTS.some((s) => s.id === req.body?.slot) ? req.body.slot : 'now';
    if (!title) return fail(res, 400, 'Type the step in a few words, for example "Finish my portfolio website".');
    if (ownSteps(req.user.id).length >= 12) return fail(res, 409, 'You have 12 steps of your own. Remove one to add another.');
    h.run('INSERT INTO own_steps (user_id, title, slot) VALUES (?, ?, ?)', req.user.id, title, slot);
    res.status(201).json({ own: ownSteps(req.user.id) });
  });
  app.patch('/api/me/steps/:id', need('student'), needConsent('profile'), (req, res) => {
    const cur = h.get('SELECT * FROM own_steps WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); if (!cur) return fail(res, 404, 'Not found.');
    const title = req.body?.title === undefined ? cur.title : L.clean(req.body.title, 120); if (!title) return fail(res, 400, 'Type the step in a few words.');
    h.run('UPDATE own_steps SET title = ?, slot = ?, done = ? WHERE id = ?', title, D.SLOTS.some((s) => s.id === req.body?.slot) ? req.body.slot : cur.slot, req.body?.done === undefined ? cur.done : req.body.done ? 1 : 0, cur.id);
    res.json({ own: ownSteps(req.user.id) });
  });
  app.delete('/api/me/steps/:id', need('student'), needConsent('profile'), (req, res) => {
    h.run('DELETE FROM own_steps WHERE id = ? AND user_id = ?', +req.params.id, req.user.id); res.json({ own: ownSteps(req.user.id) });
  });
  // A short, personal summary for whoever is signed in: what is theirs and what is waiting for them today.
  app.get('/api/me/today', need(), (req, res) => {
    const u = req.user, n = (sql, ...a) => h.get(sql, ...a).n, lines = [], plural = (k, one, many) => k + ' ' + (k === 1 ? one : many);
    const first = u.name.replace(/^(dr|prof|mr|mrs|ms|shri|smt)\.?\s+/i, '').split(/[\s,]+/)[0] || u.name;
    if (u.role === 'student') {
      const c = hasConsent(u.id, 'profile') ? computeFor(u.id) : null;
      if (!c) lines.push('Start by choosing what NGRM may store, then fill in your profile.');
      else {
        lines.push(`${D.programme(c.p.prog).label}, aiming for ${D.ROLES[c.p.role].label} · ${D.pathNote(c.p).label.toLowerCase()} · score ${c.result.index.toFixed(1)}`);
        const wait = []; if (c.result.flags.cgpaUnconfirmed) wait.push('your CGPA to be confirmed'); if (c.result.flags.skillsUnassessed) wait.push(plural(c.result.flags.skillsUnassessed, 'skill', 'skills') + ' to be assessed');
        const pend = n("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND status = 'pending'", u.id); if (pend) wait.push(plural(pend, 'evidence item', 'evidence items') + ' to be verified');
        if (wait.length) lines.push('Waiting on your mentor: ' + wait.join(', ') + '.');
        const proof = n("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND status = 'needs_proof'", u.id); if (proof) lines.push(`Your mentor asked for proof on ${plural(proof, 'item', 'items')}.`);
        const todo = ownSteps(u.id).filter((s) => !s.done).length; if (todo) lines.push(`${plural(todo, 'step', 'steps')} of your own still to do.`);
        if (!c.row.goal) lines.push('Tell NGRM your goal in your own words on My score, and your plan will follow it.');
      }
    } else if (u.role === 'mentor') {
      const ids = h.all('SELECT student_id AS id FROM mentor_links WHERE mentor_id = ?', u.id).map((x) => x.id).filter((id) => hasConsent(id, 'profile'));
      let cg = 0, sk = 0, ev = 0;
      for (const id of ids) { const c = computeFor(id); if (!c) continue; if (c.result.flags.cgpaUnconfirmed) cg++; if (c.result.flags.skillsUnassessed) sk++; ev += n("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND status = 'pending'", id); }
      lines.push(`You mentor ${plural(ids.length, 'student', 'students')}.`);
      const wait = []; if (ev) wait.push(plural(ev, 'evidence item', 'evidence items') + ' to verify'); if (cg) wait.push(plural(cg, 'CGPA', 'CGPAs') + ' to confirm'); if (sk) wait.push(plural(sk, 'student', 'students') + ' with skills to assess');
      lines.push(wait.length ? 'Waiting for you: ' + wait.join(', ') + '.' : 'Nothing is waiting for you.');
    } else if (u.role === 'college_admin') {
      const inst = h.get('SELECT name FROM institutions WHERE id = ?', u.institution_id) || { name: 'your college' };
      const st = n("SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND institution_id = ?", u.institution_id), noMentor = n("SELECT COUNT(*) AS n FROM users u WHERE u.role = 'student' AND u.institution_id = ? AND NOT EXISTS (SELECT 1 FROM mentor_links l WHERE l.student_id = u.id)", u.institution_id);
      lines.push(`${inst.name}: ${plural(st, 'student', 'students')} on NGRM.`);
      if (noMentor) lines.push(`${plural(noMentor, 'student has', 'students have')} no mentor yet. Ask the NGRM admin to link them.`);
      const intro = n("SELECT COUNT(*) AS n FROM intro_requests WHERE created_at > datetime('now', '-30 days')"); if (intro) lines.push(`${plural(intro, 'introduction request', 'introduction requests')} from employers in the last 30 days.`);
    } else if (u.role === 'employer') {
      const e = h.get('SELECT name FROM employers WHERE id = ?', u.employer_id) || { name: 'your organisation' };
      const posts = h.all("SELECT role, openings FROM demand_posts WHERE employer_id = ? AND created_at > datetime('now', '-90 days')", u.employer_id);
      lines.push(posts.length ? `${e.name}: ${plural(posts.length, 'requirement', 'requirements')} posted, ${posts.reduce((t, p) => t + p.openings, 0)} openings, for ${[...new Set(posts.map((p) => (D.ROLES[p.role] || {}).label).filter(Boolean))].slice(0, 3).join(', ')}.` : `${e.name}: no requirement posted yet. Type the role you are hiring for to start.`);
    } else if (u.role === 'researcher') {
      lines.push(`${plural(n('SELECT COUNT(DISTINCT user_id) AS n FROM baselines'), 'participant has', 'participants have')} a baseline in the study.`);
    } else if (u.role === 'admin') {
      const su = n("SELECT COUNT(*) AS n FROM signups WHERE status = 'waiting'"), col = n('SELECT COUNT(*) AS n FROM institutions WHERE pending = 1'), rv = n('SELECT COUNT(*) AS n FROM custom_roles WHERE needs_review = 1'), nm = n("SELECT COUNT(*) AS n FROM users u WHERE u.role = 'student' AND NOT EXISTS (SELECT 1 FROM mentor_links l WHERE l.student_id = u.id)");
      const wait = []; if (su) wait.push(plural(su, 'sign-up request', 'sign-up requests')); if (col) wait.push(plural(col, 'typed college', 'typed colleges') + ' to confirm'); if (rv) wait.push(plural(rv, 'typed role', 'typed roles') + ' needing skills'); if (nm) wait.push(plural(nm, 'student', 'students') + ' without a mentor');
      lines.push(wait.length ? 'Waiting for you: ' + wait.join(', ') + '.' : 'Nothing is waiting for you.');
    }
    res.json({ first, lines });
  });
  function profilePayload(userId) {
    const c = computeFor(userId); if (!c) return null;
    const last = h.get('SELECT id, formula_version, index_value, created_at FROM score_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);
    const verified = Object.keys(verifiedSkills(userId, c.p.role)).map(Number);
    return { profile: { ...c.p, optInIntros: !!c.row.opt_in_intros, verifiedSkills: verified, commVerified: verifiedComm(userId) != null }, mine: inWords(c.row), interestRoles: interestRoles(c.row, c.p), path: D.pathNote(c.p), score: c.result, band: D.band(c.result.index), lastRecorded: last || null };
  }
  // Withdrawing questionnaire consent removes the answers everywhere they were kept, including recorded scores and the study baseline.
  function scrubPsychometric(userId) {
    h.tx(() => {
      h.run('UPDATE profiles SET ocean_json = NULL WHERE user_id = ?', userId);
      for (const r of h.all('SELECT id, inputs_json, factors_json FROM score_runs WHERE user_id = ?', userId)) {
        const inputs = parse(r.inputs_json, {}), factors = parse(r.factors_json, {});
        if (inputs.profile && inputs.profile.ocean) inputs.profile.ocean = 'withdrawn';
        if ('psychometric' in factors) factors.psychometric = null;
        h.run('UPDATE score_runs SET inputs_json = ?, factors_json = ? WHERE id = ?', JSON.stringify(inputs), JSON.stringify(factors), r.id);
      }
    });
  }
  app.get('/api/me/profile', need('student'), needConsent('profile'), (req, res) => {
    if (!profileRow(req.user.id)) h.run('INSERT INTO profiles (user_id, opt_in_intros) VALUES (?, ?)', req.user.id, hasConsent(req.user.id, 'introductions') ? 1 : 0);
    res.json(profilePayload(req.user.id));
  });
  app.put('/api/me/profile', need('student'), needConsent('profile'), (req, res) => {
    const b = req.body || {}; const cur = profileRow(req.user.id) || {};
    const prog = D.PROGRAMMES.find((x) => x.id === b.prog) ? b.prog : cur.programme || 'ba-psy';
    const years = D.PROGRAMMES.find((x) => x.id === prog).years;
    const role = has(D.ROLES, b.role) ? b.role : has(D.ROLES, cur.target_role) ? cur.target_role : 'hr';
    const num = (v, lo, hi) => (v === '' || v === null || v === undefined || Number.isNaN(+v) ? null : D.clamp(+v, lo, hi));
    if (b.cgpa !== undefined && b.cgpa !== '' && b.cgpa !== null && !(Number(b.cgpa) >= 0 && Number(b.cgpa) <= 10)) return fail(res, 400, 'CGPA must be a number from 0 to 10.');
    // A field left out of the request keeps its stored value; an empty value clears it.
    const keep = (field, col, hi) => (b[field] === undefined ? cur[col] ?? null : num(b[field], 0, hi));
    // CGPA and career clarity can be corrected but not cleared once given: a blank is left out of the score,
    // so clearing a low value would otherwise raise it.
    const sticky = (field, col, hi) => { const v = keep(field, col, hi); return v === null ? cur[col] ?? null : v; };
    const newCgpa = sticky('cgpa', 'cgpa', 10);
    const prevSkills = parse(cur.skills_json, [50, 50, 50, 50]);
    const skills = Array.isArray(b.skills) && b.skills.length === 4 ? b.skills.map((s, i) => Math.round(num(s, 0, 100) ?? (role === cur.target_role ? prevSkills[i] : 50))) : prevSkills.slice();
    // A skill verified by a college assessment keeps the assessed value; the student cannot overwrite it.
    for (const [i, v] of Object.entries(verifiedSkills(req.user.id, role))) if (v != null) skills[+i] = v;
    // Questionnaire answers: keep what is stored unless new answers are sent; never store them without consent.
    let ocean = hasConsent(req.user.id, 'psychometric') ? parse(cur.ocean_json, null) : null;
    // New answers are stored only when all five traits are given; nothing is filled in on the student's behalf.
    if (b.ocean === null && b.ocean !== undefined) ocean = null;
    else if (b.ocean && typeof b.ocean === 'object' && hasConsent(req.user.id, 'psychometric')) {
      const vals = ['o', 'c', 'e', 'a', 'n'].map((k) => num(b.ocean[k], 0, 100));
      if (vals.every((v) => v !== null)) ocean = Object.fromEntries(['o', 'c', 'e', 'a', 'n'].map((k, i) => [k, Math.round(vals[i])]));
    }
    h.run(`INSERT INTO profiles (user_id, programme, year, cgpa, target_role, skills_json, ocean_json, comm, clarity, opt_in_intros, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${hasConsent(req.user.id, 'introductions') ? 1 : 0}, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET programme=excluded.programme, year=excluded.year, cgpa=excluded.cgpa, target_role=excluded.target_role,
           skills_json=excluded.skills_json, ocean_json=excluded.ocean_json, comm=excluded.comm, clarity=excluded.clarity, updated_at=excluded.updated_at`,
      req.user.id, prog, Math.min(Math.max(1, parseInt(b.year, 10) || cur.year || 1), years), newCgpa, role, JSON.stringify(skills), ocean ? JSON.stringify(ocean) : null, verifiedComm(req.user.id), sticky('clarity', 'clarity', 100));
    // In the student's own words. These personalise suggestions and what the mentor sees; they never change the score.
    const words = (field, col, max) => (b[field] === undefined ? cur[col] ?? null : L.clean(b[field], max));
    let own = parse(cur.own_skills_json, []);
    if (Array.isArray(b.ownSkills)) {
      const seen = new Set(); own = [];
      for (const x of b.ownSkills.slice(0, 20)) { const name = L.clean(x && x.name, 40); if (!name || seen.has(L.norm(name)) || own.length >= 8) continue; seen.add(L.norm(name)); own.push({ name, level: Math.round(num(x.level, 0, 100) ?? 50) }); }
    }
    h.run('UPDATE profiles SET goal = ?, interests = ?, cities = ?, own_skills_json = ? WHERE user_id = ?', words('goal', 'goal', 200), words('interests', 'interests', 200), words('cities', 'cities', 120), JSON.stringify(own), req.user.id);
    // A changed CGPA has to be confirmed again by the mentor before it counts.
    if (newCgpa !== (cur.cgpa ?? null)) h.run('UPDATE profiles SET cgpa_confirmed = 0 WHERE user_id = ?', req.user.id);
    // A new target role means a different plan: earlier accepted steps and mentor reviews no longer apply.
    if (cur.target_role && cur.target_role !== role) {
      h.run('DELETE FROM recommendation_states WHERE user_id = ?', req.user.id);
      audit(req.user.id, 'plan.reset_for_new_role', role);
    }
    audit(req.user.id, 'profile.updated');
    res.json(profilePayload(req.user.id));
  });
  app.post('/api/me/score', need('student'), needConsent('profile'), (req, res) => {
    const c = computeFor(req.user.id); if (!c) return fail(res, 404, 'Fill in your profile first.');
    const inputs = JSON.stringify({ profile: c.p, counts: c.result.counts });
    const last = h.get('SELECT id, formula_version, inputs_json FROM score_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1', req.user.id);
    if (last && last.formula_version === c.result.version && last.inputs_json === inputs) return res.json({ id: last.id, alreadyRecorded: true, ...c.result });
    const r = h.run('INSERT INTO score_runs (user_id, formula_version, inputs_json, factors_json, index_value) VALUES (?, ?, ?, ?, ?)',
      req.user.id, c.result.version, inputs, JSON.stringify(c.result.factors), c.result.index);
    audit(req.user.id, 'score.recorded', r.lastInsertRowid);
    res.json({ id: Number(r.lastInsertRowid), ...c.result });
  });
  app.get('/api/me/score-history', need('student'), needConsent('profile'), (req, res) => {
    res.json(h.all('SELECT id, formula_version, index_value, created_at FROM score_runs WHERE user_id = ? ORDER BY id DESC LIMIT 20', req.user.id));
  });

  // ---------- Student: evidence ----------
  app.get('/api/me/evidence', need('student'), needConsent('profile'), (req, res) => res.json(evidenceOf(req.user.id)));
  app.post('/api/me/evidence', need('student'), needConsent('profile'), (req, res) => {
    const b = req.body || {};
    if (!has(D.EVIDENCE_TYPES, b.type) || b.type === 'assessment') return fail(res, 400, 'Choose a type of evidence.');
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return fail(res, 400, 'Say what the evidence is, for example the course or project name.');
    // Keeps a mentor's queue usable: a student can have 10 items waiting for a check and 60 in all.
    const mine = h.get("SELECT COUNT(*) AS total, SUM(status != 'verified') AS waiting FROM evidence WHERE user_id = ? AND type != 'assessment'", req.user.id);
    if (mine.waiting >= 10) return fail(res, 409, 'You have 10 items waiting for your mentor. Add more once some have been checked.');
    if (mine.total >= 60) return fail(res, 409, 'You have reached the limit of 60 evidence items. Remove one you no longer need first.');
    let date = null;
    if (b.completedOn) {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(b.completedOn) ? new Date(b.completedOn + 'T00:00:00Z') : null;
      if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== b.completedOn) return fail(res, 400, 'Enter a real date.');
      if (d.getTime() > Date.now()) return fail(res, 400, 'The completion date cannot be in the future. Add it once you have finished.');
      if (d.getUTCFullYear() < 2000) return fail(res, 400, 'Check the year of the completion date.');
      date = b.completedOn;
    }
    const r = h.run('INSERT INTO evidence (user_id, type, title, completed_on, file_name) VALUES (?, ?, ?, ?, ?)', req.user.id, b.type, title, date, String(b.fileName || '').trim().slice(0, 200) || null);
    audit(req.user.id, 'evidence.added', r.lastInsertRowid);
    res.status(201).json(evidenceOf(req.user.id));
  });
  // Add proof to an item (for example after a mentor asked for it). It goes back to the mentor for checking.
  app.patch('/api/me/evidence/:id', need('student'), needConsent('profile'), (req, res) => {
    const e = h.get('SELECT * FROM evidence WHERE id = ? AND user_id = ?', +req.params.id, req.user.id);
    if (!e) return fail(res, 404, 'Not found.');
    if (e.status === 'verified' || e.type === 'assessment') return fail(res, 409, 'This is already verified.');
    const file = String(req.body?.fileName || '').trim().slice(0, 200);
    if (!file) return fail(res, 400, 'Name the proof you are adding, for example the certificate file.');
    h.run("UPDATE evidence SET file_name = ?, status = 'pending' WHERE id = ?", file, e.id);
    audit(req.user.id, 'evidence.proof_added', e.id);
    res.json(evidenceOf(req.user.id));
  });
  // Upload a proof file (PDF, PNG or JPEG, up to 5 MB). The body is the file itself.
  app.put('/api/me/evidence/:id/file', need('student'), needConsent('profile'), express.raw({ type: Object.keys(FILE_TYPES), limit: '5mb' }), (req, res) => {
    const e = h.get('SELECT * FROM evidence WHERE id = ? AND user_id = ?', +req.params.id, req.user.id);
    if (!e) return fail(res, 404, 'Not found.');
    if (e.status === 'verified' || e.type === 'assessment') return fail(res, 409, 'This is already verified.');
    const kind = FILE_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
    if (!kind || !Buffer.isBuffer(req.body) || !req.body.length) return fail(res, 400, 'Upload a PDF, PNG or JPEG file.');
    if (!kind[1](req.body)) return fail(res, 400, 'That file does not look like a real PDF, PNG or JPEG.');
    let name = ''; try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { name = ''; }
    name = name.replace(/[\\/\u0000-\u001f"<>]/g, '').trim().slice(0, 120) || 'proof.' + kind[0];
    const stored = crypto.randomBytes(16).toString('hex') + '.' + kind[0];
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, stored), req.body, { mode: 0o600 });
    dropFile(e.file_path);
    h.run("UPDATE evidence SET file_name = ?, file_path = ?, file_type = ?, status = 'pending' WHERE id = ?", name, stored, Object.keys(FILE_TYPES).find((t) => FILE_TYPES[t] === kind), e.id);
    audit(req.user.id, 'evidence.file_uploaded', e.id);
    res.json(evidenceOf(req.user.id));
  });
  // Only the student and their own mentor can open a proof file.
  app.get('/api/evidence/:id/file', need('student', 'mentor'), (req, res) => {
    const e = h.get('SELECT * FROM evidence WHERE id = ?', +req.params.id);
    const allowed = e && e.file_path && (e.user_id === req.user.id || (req.user.role === 'mentor' && isMentee(req.user.id, e.user_id) && hasConsent(e.user_id, 'profile')));
    if (!allowed) return fail(res, 404, 'Not found.');
    const full = path.join(uploadDir, path.basename(e.file_path));
    if (!fs.existsSync(full)) return fail(res, 404, 'Not found.');
    if (req.user.role === 'mentor') audit(req.user.id, 'mentor.opened_proof', e.id);
    res.set({ 'Content-Type': e.file_type, 'Content-Disposition': `inline; filename="${encodeURIComponent(e.file_name || 'proof')}"`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
    fs.createReadStream(full).pipe(res);
  });
  app.delete('/api/me/evidence/:id', need('student'), (req, res) => {
    // College assessments are recorded by a mentor and stay on record.
    dropFile((h.get("SELECT file_path FROM evidence WHERE id = ? AND user_id = ? AND type != 'assessment'", +req.params.id, req.user.id) || {}).file_path);
    const r = h.run("DELETE FROM evidence WHERE id = ? AND user_id = ? AND type != 'assessment'", +req.params.id, req.user.id);
    if (!r.changes) return fail(res, 404, 'Not found.');
    audit(req.user.id, 'evidence.removed', req.params.id);
    res.json(evidenceOf(req.user.id));
  });

  // ---------- Student: recommendations ----------
  app.get('/api/me/recommendations', need('student'), needConsent('profile'), async (req, res, next) => {
    try {
      const r = recsFor(req.user.id); if (!r) return fail(res, 404, 'Fill in your profile first.');
      if (hasConsent(req.user.id, 'ai_wording') && process.env.GEMINI_API_KEY) {
        await Promise.all(r.list.map(async (x) => {
          const src = ai.sourceHash(x.why);
          if (x.state?.ai_source_hash === src && x.state.ai_text) { x.aiWhy = x.state.ai_text; return; }
          const text = await ai.rewrite(x.why, D.ROLES[r.c.p.role].label);
          if (text && hasConsent(req.user.id, 'ai_wording')) {
            h.run(`INSERT INTO recommendation_states (user_id, rule_id, ai_source_hash, ai_text) VALUES (?, ?, ?, ?)
                   ON CONFLICT(user_id, rule_id) DO UPDATE SET ai_source_hash = excluded.ai_source_hash, ai_text = excluded.ai_text`, req.user.id, x.id, src, text);
            x.aiWhy = text;
          }
        }));
      }
      const accepted = r.list.filter((x) => x.state?.student_status === 'accepted').map((x) => x.id);
      res.json({ score: r.c.result, projected: D.projectIndex(r.c.p, r.c.ev, accepted), role: r.c.p.role, programme: r.c.p.prog, year: r.c.p.year, path: D.pathNote(r.c.p), own: ownSteps(req.user.id), mine: inWords(r.c.row),
        items: r.list.map((x) => ({ id: x.id, factor: x.factor, slot: x.slot, effort: x.effort, gain: x.gain, always: x.always, title: x.title, what: x.what, why: x.why, aiWhy: x.aiWhy || null, assume: x.assume, learn: x.learn,
          student: x.state?.student_status || null, mentor: x.state?.mentor_status || null, mentorNote: x.state?.mentor_note || null,
          mentorName: x.state?.mentor_id ? (h.get('SELECT name FROM users WHERE id = ?', x.state.mentor_id) || {}).name : null })) });
    } catch (e) { next(e); }
  });
  app.patch('/api/me/recommendations/:ruleId', need('student'), needConsent('profile'), (req, res) => {
    const action = req.body?.action; const ruleId = req.params.ruleId;
    if (!['accept', 'decline', 'undo'].includes(action)) return fail(res, 400, 'Unknown action.');
    if (!h.get('SELECT id FROM rules WHERE id = ?', ruleId)) return fail(res, 404, 'Not found.');
    const status = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : null;
    h.run(`INSERT INTO recommendation_states (user_id, rule_id, student_status, student_at) VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(user_id, rule_id) DO UPDATE SET student_status = excluded.student_status, student_at = excluded.student_at`, req.user.id, ruleId, status);
    audit(req.user.id, 'recommendation.' + action, ruleId);
    res.json({ ok: true });
  });

  // ---------- Student: sharing, study, data rights ----------
  app.patch('/api/me/intro-opt-in', need('student'), needConsent('profile'), (req, res) => {
    const on = !!req.body?.optIn, c = consents(req.user.id);
    // Under-18s: this consent is recorded with the guardian already on file, and needs one.
    if (on && !c.isAdult && !c.guardianName) return fail(res, 400, 'Students under 18 need a parent or guardian’s consent. Add it in the consent form below.');
    h.tx(() => {
      h.run('INSERT INTO consents (user_id, purpose, granted, is_adult, guardian_name) VALUES (?, ?, ?, ?, ?)', req.user.id, 'introductions', on ? 1 : 0, c.isAdult ? 1 : 0, c.isAdult ? null : c.guardianName);
      h.run('UPDATE profiles SET opt_in_intros = ? WHERE user_id = ?', on ? 1 : 0, req.user.id);
    });
    audit(req.user.id, 'introductions.' + (on ? 'on' : 'off'));
    res.json({ optIn: on });
  });
  app.post('/api/me/baseline', need('student'), needConsent('profile'), needConsent('study'), (req, res) => {
    const c = computeFor(req.user.id); if (!c) return fail(res, 404, 'Fill in your profile first.');
    // A baseline is the starting point for the study, so it is recorded once.
    const prev = h.get('SELECT created_at FROM baselines WHERE user_id = ? ORDER BY id LIMIT 1', req.user.id);
    if (prev) return fail(res, 409, `Your study baseline was already recorded on ${prev.created_at.slice(0, 10)}. It is recorded only once.`);
    const run = h.run('INSERT INTO score_runs (user_id, formula_version, inputs_json, factors_json, index_value) VALUES (?, ?, ?, ?, ?)',
      req.user.id, c.result.version, JSON.stringify({ profile: c.p, counts: c.result.counts }), JSON.stringify(c.result.factors), c.result.index);
    h.run('INSERT INTO baselines (user_id, score_run_id) VALUES (?, ?)', req.user.id, run.lastInsertRowid);
    audit(req.user.id, 'study.baseline_recorded');
    res.status(201).json({ index: c.result.index, factors: c.result.factors, version: c.result.version });
  });
  app.get('/api/me/export', need('student'), (req, res) => {
    const id = req.user.id;
    audit(id, 'data.exported');
    res.json({ exportedAt: new Date().toISOString(), account: { name: req.user.name, email: req.user.email },
      consents: h.all('SELECT purpose, granted, is_adult, guardian_name, created_at FROM consents WHERE user_id = ? ORDER BY id', id),
      profile: profileRow(id) ? toDomain(profileRow(id)) : null, evidence: evidenceOf(id),
      scoreRuns: h.all('SELECT formula_version, inputs_json, factors_json, index_value, created_at FROM score_runs WHERE user_id = ? ORDER BY id', id)
        .map((r) => ({ formulaVersion: r.formula_version, inputs: parse(r.inputs_json, {}), factors: parse(r.factors_json, {}), index: r.index_value, recordedAt: r.created_at })),
      recommendationDecisions: h.all('SELECT r.rule_id, r.student_status, r.student_at, r.mentor_status, r.mentor_note, u.name AS mentor_name, r.mentor_at, r.ai_text FROM recommendation_states r LEFT JOIN users u ON u.id = r.mentor_id WHERE r.user_id = ?', id),
      studyBaselines: h.all('SELECT b.created_at, s.formula_version, s.index_value FROM baselines b JOIN score_runs s ON s.id = b.score_run_id WHERE b.user_id = ? ORDER BY b.id', id),
      introductionReplies: h.all('SELECT e.name AS employer, r.role, x.created_at FROM intro_replies x JOIN intro_requests r ON r.id = x.request_id JOIN employers e ON e.id = r.employer_id WHERE x.user_id = ?', id),
      accessLog: h.all('SELECT action, target, at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 200', id) });
  });
  app.delete('/api/me', need('student'), (req, res) => {
    const id = req.user.id;
    if (req.body?.confirm !== 'DELETE') return fail(res, 400, 'Confirm by sending confirm: "DELETE".');
    removeAccount(req.user);
    audit(null, 'account.deleted', 'user:' + id);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ deleted: true });
  });

  function removeAccount(u) {
    for (const e of h.all('SELECT file_path FROM evidence WHERE user_id = ? AND file_path IS NOT NULL', u.id)) dropFile(e.file_path);
    h.tx(() => { h.run('DELETE FROM login_failures WHERE email = ?', u.email); h.run('UPDATE recommendation_states SET mentor_id = NULL WHERE mentor_id = ?', u.id); h.run('DELETE FROM otp_codes WHERE email = ?', u.email); h.run('DELETE FROM otp_requests WHERE email = ?', u.email); h.run('DELETE FROM users WHERE id = ?', u.id); });
  }

  // ---------- Live platform activity ----------
  const ACTIVITY = { signIns: "action = 'auth.signed_in'", scores: "action = 'score.recorded'", evidence: "action IN ('evidence.added', 'evidence.proof_added', 'evidence.file_uploaded')", decisions: "action LIKE 'recommendation.%'", reviews: "action LIKE 'mentor.review.%' OR action LIKE 'mentor.evidence.%' OR action = 'mentor.assessment_recorded'", demand: "action = 'employer.posted_demand'" };
  const activityCounts = (since, scope, args) => Object.fromEntries(Object.entries(ACTIVITY).map(([k, where]) => [k, h.get(`SELECT COUNT(*) AS n FROM audit_log WHERE (${where}) AND at > datetime('now', ?)${scope}`, since, ...args).n]));
  // Admin: the whole platform, exact. No names, only counts.
  app.get('/api/admin/activity', need('admin'), (req, res) => {
    const days = h.all(`SELECT date(at) AS day, COUNT(*) AS actions, COUNT(DISTINCT user_id) AS people FROM audit_log WHERE at > datetime('now', '-13 days', 'start of day') GROUP BY date(at) ORDER BY day`);
    res.json({ today: activityCounts('start of day', '', []), week: activityCounts('-7 days', '', []), days,
      activeToday: h.get("SELECT COUNT(DISTINCT user_id) AS n FROM audit_log WHERE at > datetime('now', 'start of day') AND user_id IS NOT NULL").n,
      waiting: { evidence: h.get("SELECT COUNT(*) AS n FROM evidence WHERE status = 'pending'").n, proof: h.get("SELECT COUNT(*) AS n FROM evidence WHERE status = 'needs_proof'").n },
      asOf: new Date().toISOString() });
  });
  // Placement cell: their own college over the last 7 days, hidden under 5 and rounded to 5 like every other college figure.
  app.get('/api/college/activity', need('college_admin', 'mentor'), (req, res) => {
    const scope = " AND user_id IN (SELECT id FROM users WHERE role = 'student' AND institution_id = ?)", inst = [req.user.institution_id];
    const wk = activityCounts('-7 days', scope, inst);
    res.json({ windowDays: 7, rounding: 5,
      activeStudents: approx(h.get(`SELECT COUNT(DISTINCT user_id) AS n FROM audit_log WHERE at > datetime('now', '-7 days')${scope}`, ...inst).n),
      scores: approx(wk.scores), evidence: approx(wk.evidence), decisions: approx(wk.decisions),
      awaitingCheck: approx(h.get("SELECT COUNT(*) AS n FROM evidence e JOIN users u ON u.id = e.user_id WHERE e.status = 'pending' AND u.institution_id = ?", ...inst).n),
      asOf: new Date().toISOString() });
  });

  // ---------- Mentor ----------
  const isMentee = (mentorId, studentId) => !!h.get('SELECT 1 FROM mentor_links WHERE mentor_id = ? AND student_id = ?', mentorId, studentId);
  app.get('/api/mentor/mentees', need('mentor'), (req, res) => {
    const rows = h.all('SELECT u.id, u.name FROM mentor_links m JOIN users u ON u.id = m.student_id WHERE m.mentor_id = ? ORDER BY u.name', req.user.id);
    const out = rows.filter((r) => hasConsent(r.id, 'profile')).map((r) => {
      const c = computeFor(r.id); if (!c) return null;
      return { id: r.id, name: r.name, programme: c.p.prog, year: c.p.year, role: c.p.role, index: c.result.index, band: D.band(c.result.index),
        fit: D.pathNote(c.p).label, inWords: { ...inWords(c.row), steps: ownSteps(r.id) }, cgpa: c.p.cgpa, cgpaConfirmed: c.p.cgpaConfirmed, skills: c.p.skills, skillsVerified: c.p.skillsVerified, commAssessed: c.result.factors.communication !== null };
    }).filter(Boolean);
    audit(req.user.id, 'mentor.viewed_mentees');
    res.json(out);
  });
  app.get('/api/mentor/queue', need('mentor'), (req, res) => {
    const mentees = h.all('SELECT u.id, u.name FROM mentor_links m JOIN users u ON u.id = m.student_id WHERE m.mentor_id = ? ORDER BY u.id', req.user.id);
    const recItems = [], evItems = [];
    for (const s of mentees) {
      if (!hasConsent(s.id, 'profile')) continue;
      const r = recsFor(s.id); if (!r) continue;
      for (const x of r.list) recItems.push({ studentId: s.id, studentName: s.name, ruleId: x.id, title: x.title, why: x.why, gain: x.gain,
        student: x.state?.student_status || null, mentor: x.state?.mentor_status || null, note: x.state?.mentor_note || null });
      for (const e of r.c.ev.filter((e) => e.status !== 'verified')) evItems.push({ studentId: s.id, studentName: s.name, ...e, typeLabel: D.EVIDENCE_TYPES[e.type] });
    }
    res.json({ recommendations: recItems, evidence: evItems });
  });
  app.patch('/api/mentor/reviews/:studentId/:ruleId', need('mentor'), (req, res) => {
    const sid = +req.params.studentId, ruleId = req.params.ruleId, action = req.body?.action;
    if (!isMentee(req.user.id, sid) || !hasConsent(sid, 'profile')) return fail(res, 404, 'Not found.');
    if (!h.get('SELECT id FROM rules WHERE id = ?', ruleId)) return fail(res, 404, 'Not found.');
    if (!['approve', 'note', 'reopen'].includes(action)) return fail(res, 400, 'Unknown action.');
    const st = h.get('SELECT student_status FROM recommendation_states WHERE user_id = ? AND rule_id = ?', sid, ruleId);
    if (st?.student_status === 'declined' && action !== 'reopen') return fail(res, 409, 'The student declined this. Declines need no reason and cannot be overridden.');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (action === 'note' && !note) return fail(res, 400, 'Write a note first, or approve.');
    const status = action === 'approve' ? 'approved' : action === 'note' ? 'note' : null;
    h.run(`INSERT INTO recommendation_states (user_id, rule_id, mentor_status, mentor_note, mentor_id, mentor_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(user_id, rule_id) DO UPDATE SET mentor_status = excluded.mentor_status, mentor_note = excluded.mentor_note, mentor_id = excluded.mentor_id, mentor_at = excluded.mentor_at`,
      sid, ruleId, status, status ? note || null : null, req.user.id);
    audit(req.user.id, 'mentor.review.' + action, sid + ':' + ruleId);
    res.json({ ok: true });
  });
  app.post('/api/mentor/evidence/:id', need('mentor'), (req, res) => {
    const e = h.get('SELECT * FROM evidence WHERE id = ?', +req.params.id);
    if (!e || !isMentee(req.user.id, e.user_id) || !hasConsent(e.user_id, 'profile')) return fail(res, 404, 'Not found.');
    const action = req.body?.action;
    if (action === 'verify') h.run("UPDATE evidence SET status = 'verified', verified_by = ?, verified_at = datetime('now') WHERE id = ?", req.user.name, e.id);
    else if (action === 'needs_proof') h.run("UPDATE evidence SET status = 'needs_proof' WHERE id = ?", e.id);
    else return fail(res, 400, 'Unknown action.');
    audit(req.user.id, 'mentor.evidence.' + action, e.id);
    res.json({ ok: true });
  });

  // A mentor records a college assessment result for a mentee. It locks that skill (or communication) score.
  app.post('/api/mentor/assessments', need('mentor'), (req, res) => {
    const sid = +req.body?.studentId, what = req.body?.what, value = Number(req.body?.value);
    if (!isMentee(req.user.id, sid) || !hasConsent(sid, 'profile')) return fail(res, 404, 'Not found.');
    const row = profileRow(sid); if (!row) return fail(res, 404, 'This student has not set up a profile yet.');
    if (what === 'cgpa') {
      // Confirming a CGPA: the mentor enters the figure from college records. It replaces what the student typed.
      if (req.body?.value === '' || req.body?.value == null || !Number.isFinite(value) || value < 0 || value > 10) return fail(res, 400, 'Enter the CGPA from college records, from 0 to 10.');
      const cgpa = Math.round(value * 100) / 100;
      h.tx(() => {
        h.run("DELETE FROM evidence WHERE user_id = ? AND type = 'assessment' AND skill_role = 'cgpa'", sid);
        h.run("INSERT INTO evidence (user_id, type, title, completed_on, status, verified_by, verified_at, skill_index, skill_role, skill_value) VALUES (?, 'assessment', ?, date('now'), 'verified', ?, datetime('now'), NULL, 'cgpa', ?)", sid, `CGPA confirmed: ${cgpa}`, req.user.name, Math.round(cgpa * 10));
        h.run('UPDATE profiles SET cgpa = ?, cgpa_confirmed = 1 WHERE user_id = ?', cgpa, sid);
      });
      audit(req.user.id, 'mentor.cgpa_confirmed', sid);
      return res.status(201).json({ ok: true, label: 'CGPA', score: cgpa, cgpa: true });
    }
    const isComm = what === 'communication', idx = isComm ? null : Number(what);
    if (!isComm && !(Number.isInteger(idx) && idx >= 0 && idx <= 3)) return fail(res, 400, 'Choose what was assessed.');
    if (req.body?.value === '' || req.body?.value == null || !Number.isFinite(value) || value < 0 || value > 100) return fail(res, 400, 'Enter a score from 0 to 100.');
    const score = Math.round(value), role = isComm ? 'communication' : row.target_role;
    const label = isComm ? 'Communication' : D.ROLES[row.target_role].skills[idx];
    h.tx(() => {
      h.run("DELETE FROM evidence WHERE user_id = ? AND type = 'assessment' AND skill_role = ? AND " + (isComm ? 'skill_index IS NULL' : 'skill_index = ?'), ...(isComm ? [sid, role] : [sid, role, idx]));
      h.run("INSERT INTO evidence (user_id, type, title, completed_on, status, verified_by, verified_at, skill_index, skill_role, skill_value) VALUES (?, 'assessment', ?, date('now'), 'verified', ?, datetime('now'), ?, ?, ?)",
        sid, `${label} assessment: ${score}/100`, req.user.name, idx, role, score);
      if (isComm) h.run('UPDATE profiles SET comm = ? WHERE user_id = ?', score, sid);
      else { const sk = parse(row.skills_json, [50, 50, 50, 50]); sk[idx] = score; h.run('UPDATE profiles SET skills_json = ? WHERE user_id = ?', JSON.stringify(sk), sid); }
    });
    audit(req.user.id, 'mentor.assessment_recorded', sid + ':' + (isComm ? 'communication' : idx));
    res.status(201).json({ ok: true, label, score });
  });

  // ---------- College (mentor or college admin; own institution, aggregates only) ----------
  app.get('/api/college/cohort', need('mentor', 'college_admin'), (req, res) => {
    // One filter at a time, a programme or a target role, so two views can never be subtracted to isolate a student.
    const role = req.query.role && req.query.role !== 'all' ? String(req.query.role) : null;
    const prog = !role && req.query.programme && req.query.programme !== 'all' ? String(req.query.programme) : null;
    const everyone = h.all("SELECT u.id, p.programme, p.target_role FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'student' AND u.institution_id = ?", req.user.institution_id)
      .filter((s) => hasConsent(s.id, 'profile'));
    const roleSizes = {}; for (const s of everyone) roleSizes[s.target_role] = (roleSizes[s.target_role] || 0) + 1;
    const progSizes = {}; for (const s of everyone) progSizes[s.programme] = (progSizes[s.programme] || 0) + 1;
    // What this college actually has, for the filter: only groups of 5 or more are named.
    const groups = { programmes: Object.keys(progSizes).filter((k) => progSizes[k] >= D.MIN_GROUP).map((k) => ({ id: k, label: D.programme(k).label })),
      roles: Object.keys(roleSizes).filter((k) => roleSizes[k] >= D.MIN_GROUP && D.ROLES[k]).map((k) => ({ id: k, label: D.ROLES[k].label })) };
    if (role && !(roleSizes[role] >= D.MIN_GROUP)) { audit(req.user.id, 'college.viewed_cohort', 'role:' + role); return res.json({ n: null, suppressed: true, smallProgrammesLeftOut: false, groups }); }
    const all = role ? everyone.filter((s) => s.target_role === role) : everyone;
    // Programmes with fewer than 5 students are left out of every view, including "all programmes".
    // Otherwise subtracting one view from another could reveal a single student's score.
    const sizes = {}; for (const s of all) sizes[s.programme] = (sizes[s.programme] || 0) + 1;
    const students = all.filter((s) => sizes[s.programme] >= D.MIN_GROUP && (!prog || s.programme === prog));
    audit(req.user.id, 'college.viewed_cohort', role ? 'role:' + role : prog || 'all');
    const leftOut = Object.values(sizes).some((n) => n < D.MIN_GROUP);
    if (students.length < D.MIN_GROUP) return res.json({ n: null, suppressed: true, smallProgrammesLeftOut: leftOut, groups });
    const rs = students.map((s) => computeFor(s.id).result);
    const bands = { building: 0, progressing: 0, ready: 0 }; rs.forEach((r) => bands[D.band(r.index).k]++);
    // Counts rounded to 5 and averages to whole numbers, so comparing views before and after one student
    // joins, leaves or withdraws consent cannot reveal that student's figures.
    const shown = { building: approx(bands.building), progressing: approx(bands.progressing), ready: approx(bands.ready) };
    // If only one band is hidden, it could be worked out from the others, so hide the next smallest too.
    const hidden = Object.keys(shown).filter((k) => shown[k] === null);
    if (hidden.length === 1) { const next = Object.keys(shown).filter((k) => shown[k] !== null).sort((a, b) => bands[a] - bands[b])[0]; shown[next] = null; }
    const factors = {}; for (const F of D.FACTORS) { const vals = rs.map((r) => r.factors[F.k]).filter((v) => v !== null); factors[F.k] = vals.length >= D.MIN_GROUP ? Math.round(D.avg(vals)) : null; }
    // For one role: how many have each of its skills assessed at the target level, so the college knows what to teach.
    const roleSkills = role ? D.ROLES[role].skills.map((name, k) => { const ok = students.filter((s) => { const v = verifiedSkills(s.id, role)[k]; return v != null && v >= D.ROLES[role].target[k]; }).length; return { name, target: D.ROLES[role].target[k], atTargetPct: safePct(ok, students.length) }; }) : null;
    res.json({ groups, roleSkills, n: approx(rs.length), suppressed: false, smallProgrammesLeftOut: leftOut, avgIndex: Math.round(D.avg(rs.map((r) => r.index))), factors, bands: shown,
      noInternshipPct: safePct(rs.filter((r) => r.counts.internship === 0).length, rs.length), rounding: 5 });
  });
  app.get('/api/demand', need(), (req, res) => {
    res.json(h.all('SELECT d.id, d.role, d.skills_json, d.extra_json, d.openings, d.city, d.created_at, d.employer_id, e.name AS employer FROM demand_posts d JOIN employers e ON e.id = d.employer_id ORDER BY d.id DESC LIMIT 50')
      .map((d) => ({ ...d, roleLabel: (D.ROLES[d.role] || {}).label || 'A role', skills: parse(d.skills_json, []).concat(parse(d.extra_json, [])), skills_json: undefined, extra_json: undefined, employer_id: undefined, mine: req.user.role === 'employer' && d.employer_id === req.user.employer_id })));
  });

  // Live demand for one role: what partner employers have posted in the last 90 days.
  app.get('/api/demand/summary', need(), (req, res) => {
    const role = has(D.ROLES, req.query.role) ? req.query.role : null; if (!role) return fail(res, 400, 'Choose a role.');
    const posts = h.all("SELECT d.skills_json, d.extra_json, d.openings, d.city, d.created_at, e.name AS employer FROM demand_posts d JOIN employers e ON e.id = d.employer_id WHERE d.role = ? AND d.created_at > datetime('now', '-90 days') ORDER BY d.id DESC", role);
    const skills = {}; for (const p of posts) for (const k of parse(p.skills_json, [])) skills[k] = (skills[k] || 0) + p.openings;
    // For a student: which of these openings are in the cities they typed, and which extra skills employers typed that they have too.
    let personal = null;
    if (req.user.role === 'student') {
      const row = profileRow(req.user.id) || {}, cities = cityList(row), mine = parse(row.own_skills_json, []).map((x) => L.norm(x.name));
      const asked = {}; for (const p of posts) for (const k of parse(p.extra_json, [])) asked[k] = (asked[k] || 0) + p.openings;
      const inCity = posts.filter((p) => p.city && cities.some((c) => L.norm(p.city).includes(c)));
      personal = { cities: row.cities || '', openingsInMyCities: cities.length ? inCity.reduce((t, p) => t + p.openings, 0) : null,
        alsoAsked: Object.entries(asked).sort((a, b) => b[1] - a[1]).map(([name, openings]) => ({ name, openings, have: mine.includes(L.norm(name)) })) };
    }
    res.json({ role, personal, openings: posts.reduce((t, p) => t + p.openings, 0), employers: new Set(posts.map((p) => p.employer)).size,
      skills: Object.entries(skills).sort((a, b) => b[1] - a[1]).map(([name, openings]) => ({ name, openings })),
      latest: posts.slice(0, 5).map((p) => ({ employer: p.employer, city: p.city, openings: p.openings, postedAt: p.created_at })), asOf: new Date().toISOString() });
  });

  // ---------- Employer (aggregates only) ----------
  app.get('/api/employer/supply', need('employer'), (req, res) => {
    if (req.query.role !== undefined && !has(D.ROLES, req.query.role)) return fail(res, 400, 'Choose a role.');
    const role = req.query.role || 'hr';
    const insts = h.all('SELECT id, name FROM institutions WHERE pending = 0 ORDER BY id');
    const rows = h.all("SELECT u.id, u.institution_id, p.skills_json, p.opt_in_intros FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'student' AND p.target_role = ?", role)
      .filter((r) => hasConsent(r.id, 'profile'));
    // Only skills a college has assessed are counted. A student with none assessed is in the pool but in no level.
    const assessedBy = {};
    for (const e of h.all("SELECT user_id, skill_index, skill_value FROM evidence WHERE type = 'assessment' AND status = 'verified' AND skill_role = ? AND skill_index BETWEEN 0 AND 3", role)) (assessedBy[e.user_id] = assessedBy[e.user_id] || {})[e.skill_index] = e.skill_value;
    for (const r of rows) r.assessed = assessedBy[r.id] || {};
    const level = (sk) => { const a = D.avg(sk); return a < 50 ? 'foundation' : a < 70 ? 'intermediate' : 'strong'; };
    const tally = (list) => {
      const t = { foundation: 0, intermediate: 0, strong: 0, optedIn: 0 };
      for (const r of list) { const sk = Object.values(r.assessed); if (sk.length) t[level(sk)]++; if (r.opt_in_intros && hasConsent(r.id, 'introductions')) t.optedIn++; }
      return { foundation: approx(t.foundation), intermediate: approx(t.intermediate), strong: approx(t.strong), optedIn: approx(t.optedIn), _opted: t.optedIn };
    };
    const byCollege = insts.map((i) => { const t = tally(rows.filter((r) => r.institution_id === i.id)); delete t._opted; return { college: i.name, ...t }; });
    const canRequest = tally(rows)._opted >= D.MIN_GROUP;
    // The total row adds up only the figures shown above it, so it cannot be used to work out a hidden college.
    const total = Object.fromEntries(['foundation', 'intermediate', 'strong', 'optedIn'].map((k) => { const shown = byCollege.map((c) => c[k]).filter((v) => v !== null); return [k, shown.length ? shown.reduce((a, b) => a + b, 0) : null]; }));
    const skills = rows.length >= D.MIN_GROUP ? D.ROLES[role].skills.map((name, k) => ({ name, sharePct: safePct(rows.filter((r) => (r.assessed[k] ?? 0) >= 70).length, rows.length) })) : null;
    audit(req.user.id, 'employer.viewed_supply', role);
    // Students often word the same job differently, so point to nearby roles that have enough students to show.
    const fam = D.ROLES[role].family, related = [];
    for (const k of Object.keys(D.ROLES)) {
      if (k === role || D.ROLES[k].family !== fam || fam === 'general') continue;
      const n = h.all("SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'student' AND p.target_role = ?", k).filter((r) => hasConsent(r.id, 'profile')).length;
      if (n >= D.MIN_GROUP) related.push({ key: k, label: D.ROLES[k].label, students: approx(n) });
    }
    res.json({ role, related, byCollege, total, canRequestIntroductions: canRequest, pool: approx(rows.length), skills, rounding: 5, totalIsSumOfShown: true, assessedOnly: true });
  });
  app.post('/api/employer/demand', need('employer'), (req, res) => {
    const b = req.body || {};
    if (!has(D.ROLES, b.role)) return fail(res, 400, 'Choose a role.');
    const skills = (Array.isArray(b.skills) ? b.skills : []).filter((s) => D.ROLES[b.role].skills.includes(s));
    // Anything else the employer needs, in their own words.
    const extra = []; for (const x of String(Array.isArray(b.extraSkills) ? b.extraSkills.join(',') : b.extraSkills || '').split(/[,;\n]/)) { const t = L.clean(x, 40); if (t && extra.length < 6 && !extra.some((e) => L.norm(e) === L.norm(t)) && !skills.some((e) => L.norm(e) === L.norm(t))) extra.push(t); }
    if (!skills.length && !extra.length) return fail(res, 400, 'Pick or type at least one skill.');
    const openings = Number(b.openings);
    if (!Number.isInteger(openings) || openings < 1 || openings > 500) return fail(res, 400, 'Openings must be a whole number from 1 to 500.');
    // One employer cannot swamp what students see: at most 3 open posts and 500 openings per role in any 90 days.
    const open = h.get("SELECT COUNT(*) AS posts, COALESCE(SUM(openings), 0) AS openings FROM demand_posts WHERE employer_id = ? AND role = ? AND created_at > datetime('now', '-90 days')", req.user.employer_id, b.role);
    if (open.posts >= 3) return fail(res, 409, 'You already have 3 requirements posted for this role in the last 90 days. Withdraw one to post another.');
    if (open.openings + openings > 500) return fail(res, 409, `That would take your openings for this role past 500 in 90 days (you have ${open.openings} posted). Lower the number or withdraw an older post.`);
    h.run('INSERT INTO demand_posts (employer_id, role, skills_json, openings, city, extra_json) VALUES (?, ?, ?, ?, ?, ?)', req.user.employer_id, b.role, JSON.stringify(skills), openings, String(b.city || '').trim().slice(0, 80) || null, JSON.stringify(extra));
    audit(req.user.id, 'employer.posted_demand', b.role);
    res.status(201).json({ ok: true });
  });
  app.delete('/api/employer/demand/:id', need('employer'), (req, res) => {
    const r = h.run('DELETE FROM demand_posts WHERE id = ? AND employer_id = ?', +req.params.id, req.user.employer_id);
    if (!r.changes) return fail(res, 404, 'Not found.');
    audit(req.user.id, 'employer.withdrew_demand', +req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/employer/intros', need('employer'), (req, res) => {
    const role = has(D.ROLES, req.body?.role) ? req.body.role : null; if (!role) return fail(res, 400, 'Choose a role.');
    const opted = h.all("SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'student' AND p.target_role = ? AND p.opt_in_intros = 1", role).filter((r) => hasConsent(r.id, 'profile') && hasConsent(r.id, 'introductions')).length;
    if (opted < D.MIN_GROUP) return fail(res, 409, 'Fewer than 5 students have opted in for this role, so introductions are not available yet.');
    if (h.get("SELECT id FROM intro_requests WHERE employer_id = ? AND role = ? AND created_at > datetime('now', '-30 days')", req.user.employer_id, role))
      return fail(res, 409, 'You already asked for introductions for this role in the last 30 days. Placement cells are working on it.');
    h.run('INSERT INTO intro_requests (employer_id, role) VALUES (?, ?)', req.user.employer_id, role);
    audit(req.user.id, 'employer.requested_intros', role);
    res.status(201).json({ ok: true, message: 'Request sent to the placement cells. Students who opted in decide whether to reply.' });
  });

  app.get('/api/employer/intros', need('employer'), (req, res) => {
    res.json(h.all('SELECT id, role, status, created_at FROM intro_requests WHERE employer_id = ? ORDER BY id DESC', req.user.employer_id)
      .map((r) => ({ ...r, replies: approx(introReplies(r.id).length) })));
  });

  // ---------- Introductions: students reply, their own placement cell sees who replied ----------
  const introReplies = (requestId, institutionId) => h.all('SELECT u.id, u.name, u.email, u.institution_id FROM intro_replies r JOIN users u ON u.id = r.user_id WHERE r.request_id = ?', requestId)
    .filter((u) => hasConsent(u.id, 'introductions') && (institutionId == null || u.institution_id === institutionId));
  const openRequestsFor = (role) => h.all("SELECT r.id, r.role, r.created_at, e.name AS employer, e.city FROM intro_requests r JOIN employers e ON e.id = r.employer_id WHERE r.role = ? AND r.created_at > datetime('now', '-90 days') ORDER BY r.id DESC", role);
  app.get('/api/me/intro-requests', need('student'), needConsent('profile'), (req, res) => {
    const p = profileRow(req.user.id);
    if (!p || !p.opt_in_intros || !hasConsent(req.user.id, 'introductions')) return res.json({ optedIn: false, requests: [] });
    const mine = new Set(h.all('SELECT request_id FROM intro_replies WHERE user_id = ?', req.user.id).map((r) => r.request_id));
    res.json({ optedIn: true, requests: openRequestsFor(p.target_role).map((r) => ({ ...r, interested: mine.has(r.id) })) });
  });
  app.post('/api/me/intro-requests/:id', need('student'), needConsent('profile'), needConsent('introductions'), (req, res) => {
    const p = profileRow(req.user.id), r = h.get('SELECT * FROM intro_requests WHERE id = ?', +req.params.id);
    const open = r && h.get("SELECT 1 FROM intro_requests WHERE id = ? AND created_at > datetime('now', '-90 days')", r.id);
    if (!r || !open || !p || r.role !== p.target_role || !p.opt_in_intros) return fail(res, 404, 'Not found.');
    if (req.body?.interested) h.run('INSERT OR IGNORE INTO intro_replies (request_id, user_id) VALUES (?, ?)', r.id, req.user.id);
    else h.run('DELETE FROM intro_replies WHERE request_id = ? AND user_id = ?', r.id, req.user.id);
    audit(req.user.id, 'introductions.' + (req.body?.interested ? 'interested' : 'withdrawn'), r.id);
    res.json({ interested: !!req.body?.interested });
  });
  app.get('/api/college/intro-requests', need('college_admin'), (req, res) => {
    const rows = h.all("SELECT r.id, r.role, r.created_at, e.name AS employer, e.city FROM intro_requests r JOIN employers e ON e.id = r.employer_id WHERE r.created_at > datetime('now', '-90 days') ORDER BY r.id DESC")
      .map((r) => ({ ...r, students: introReplies(r.id, req.user.institution_id).map((u) => ({ name: u.name, email: u.email })) }));
    audit(req.user.id, 'college.viewed_intro_replies');
    res.json(rows);
  });

  // ---------- Researcher (consented, de-identified) ----------
  app.get('/api/research/export', need('researcher'), (req, res) => {
    const rows = h.all("SELECT b.user_id, b.created_at, s.formula_version, s.factors_json, s.index_value, p.programme, p.year, p.target_role FROM baselines b JOIN score_runs s ON s.id = b.score_run_id JOIN profiles p ON p.user_id = b.user_id")
      .filter((r) => hasConsent(r.user_id, 'study'))
      .map((r) => ({ participant: pseudo(r.user_id), recordedAt: r.created_at.slice(0, 7), formulaVersion: r.formula_version, programme: r.programme, year: r.year, targetRole: r.target_role, index: Math.round(r.index_value / 5) * 5,
        factors: Object.fromEntries(Object.entries(parse(r.factors_json, {})).map(([k, v]) => [k, typeof v === 'number' ? (k === 'academic' ? Math.min(80, Math.floor(v / 20) * 20) : Math.round(v / 5) * 5) : v])) }));
    // Academic is CGPA × 10, which classmates may know, so it is given in wide bands (40 = 40–59, 60 = 60–79, 80 = 80–100).
    // No record may stand alone on what an outsider could already know (programme, year, target role, rough CGPA).
    // Step 1: where fewer than 5 share programme + year + role, drop role, then year, then programme.
    const K = D.MIN_GROUP, groupBy = (list, key) => { const m = new Map(); for (const r of list) { const k = key(r); (m.get(k) || m.set(k, []).get(k)).push(r); } return m; };
    const q = (r) => [r.programme, r.year, r.targetRole].join('|');
    for (const field of ['targetRole', 'year', 'programme']) for (const g of groupBy(rows, q).values()) if (g.length < K) for (const r of g) r[field] = null;
    // Step 2: inside each such group, academic bands held by fewer than 5 are withheld; if the withheld set is itself under 5, the next smallest band joins it.
    for (const g of groupBy(rows, q).values()) {
      const bands = [...groupBy(g, (r) => r.factors.academic).entries()].filter(([b]) => b !== null && b !== undefined).sort((a, b) => a[1].length - b[1].length);
      let hidden = g.filter((r) => r.factors.academic == null).length;
      for (const [, list] of bands) { if (list.length >= K && (hidden === 0 || hidden >= K)) continue; for (const r of list) r.factors.academic = null; hidden += list.length; }
    }
    audit(req.user.id, 'research.exported', rows.length);
    res.json({ participants: new Set(rows.map((r) => r.participant)).size, banding: 5, academicBands: '40 = 40–59, 60 = 60–79, 80 = 80–100; withheld where fewer than 5 share it', minimumGroup: K, rows });
  });

  // ---------- Admin ----------
  app.get('/api/admin/audit', need('admin'), (req, res) => res.json(h.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100)))));
  app.get('/api/admin/rules', need('admin'), (req, res) => res.json(ruleSettings()));
  app.patch('/api/admin/rules/:id', need('admin'), (req, res) => {
    const r = h.get('SELECT * FROM rules WHERE id = ?', req.params.id); if (!r) return fail(res, 404, 'Not found.');
    const active = req.body?.active === undefined ? r.active : req.body.active ? 1 : 0;
    if (r.id === 'counsellor' && !active) return fail(res, 400, 'The counsellor referral is always offered and cannot be switched off.');
    let threshold = r.threshold;
    if (req.body?.threshold !== undefined && has(D.THRESHOLD_RANGE, r.id)) {
      const t = req.body.threshold === '' || req.body.threshold === null ? NaN : Number(req.body.threshold), [lo, hi] = D.THRESHOLD_RANGE[r.id];
      if (!Number.isFinite(t) || t < lo || t > hi) return fail(res, 400, `The threshold for ${r.id} must be a number from ${lo} to ${hi}.`);
      threshold = t;
    }
    h.run('UPDATE rules SET active = ?, threshold = ? WHERE id = ?', active, threshold, r.id);
    audit(req.user.id, 'admin.rule_updated', r.id);
    res.json(h.get('SELECT * FROM rules WHERE id = ?', r.id));
  });

  // Live course feed: status, and a test an admin can run for any skill.
  app.get('/api/admin/feeds', need('admin'), (req, res) => res.json(feeds.status()));
  app.post('/api/admin/feeds/test', need('admin'), async (req, res) => {
    const skill = String(req.body?.skill || '').trim().slice(0, 80);
    if (!skill) return fail(res, 400, 'Type a skill to search for.');
    try { const rows = await feeds.refresh(skill); res.json({ ok: true, courses: rows || [] }); }
    catch (e) { res.json({ ok: false, message: String(e.message || e).slice(0, 200) }); }
  });

  // Sign-ups from mentors, placement cells, employers and researchers wait here until an admin approves or declines them.
  app.get('/api/admin/signups', need('admin'), (req, res) => res.json(h.all("SELECT s.email, s.name, s.role, COALESCE(i.name, s.org_name) AS org, s.created_at FROM signups s LEFT JOIN institutions i ON i.id = s.institution_id WHERE s.status = 'waiting' ORDER BY s.created_at")));
  app.post('/api/admin/signups/decide', need('admin'), (req, res) => {
    const row = h.get("SELECT * FROM signups WHERE email = ? AND status = 'waiting'", String(req.body?.email || '').trim().toLowerCase());
    if (!row) return fail(res, 404, 'That request is no longer waiting.');
    if (req.body?.approve !== true) { h.run('DELETE FROM signups WHERE email = ?', row.email); audit(req.user.id, 'admin.signup_declined', row.role); return res.json({ ok: true, approved: false }); }
    if (h.get('SELECT id FROM users WHERE email = ?', row.email)) { h.run('DELETE FROM signups WHERE email = ?', row.email); return fail(res, 409, 'That email already has an account.'); }
    let employerId = null;
    if (row.role === 'employer') {
      const e = h.get('SELECT id FROM employers WHERE lower(name) = lower(?)', row.org_name);
      employerId = e ? e.id : Number(h.run('INSERT INTO employers (name, city, is_sample) VALUES (?, NULL, 0)', row.org_name).lastInsertRowid);
    }
    const user = auth.createFromSignup(row, row.institution_id, employerId);
    audit(req.user.id, 'admin.signup_approved', user.id);
    mailNotice(user.email, 'Your NGRM account is approved', `Hello ${user.name},\n\nYour NGRM account has been approved. You can now sign in with your email and the password you chose.`);
    res.json({ ok: true, approved: true });
  });

  // People and organisations: admins can also add accounts directly.
  app.get('/api/admin/people', need('admin'), (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
    res.json({ institutions: h.all('SELECT i.id, i.name, i.city, (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role = \'student\') AS students, i.pending FROM institutions i ORDER BY i.pending DESC, i.name'),
      employers: h.all('SELECT id, name, city FROM employers ORDER BY name'),
      roles: h.all('SELECT role, COUNT(*) AS n FROM users GROUP BY role'),
      recent: h.all(`SELECT u.id, u.name, u.email, u.role, COALESCE(i.name, e.name) AS org, u.created_at,
        (SELECT m.email FROM mentor_links l JOIN users m ON m.id = l.mentor_id WHERE l.student_id = u.id LIMIT 1) AS mentor FROM users u LEFT JOIN institutions i ON i.id = u.institution_id LEFT JOIN employers e ON e.id = u.employer_id
        WHERE (? = '' OR lower(u.name) LIKE ? OR lower(u.email) LIKE ?) ORDER BY u.id DESC LIMIT 15`, q, '%' + q + '%', '%' + q + '%') });
  });
  app.post('/api/admin/orgs', need('admin'), (req, res) => {
    const kind = req.body?.kind, name = String(req.body?.name || '').trim().slice(0, 160), city = String(req.body?.city || '').trim().slice(0, 80);
    if (!['institution', 'employer'].includes(kind)) return fail(res, 400, 'Choose college or employer.');
    if (!name || (kind === 'institution' && !city)) return fail(res, 400, kind === 'institution' ? 'Give the college name and city.' : 'Give the employer name.');
    const table = kind === 'institution' ? 'institutions' : 'employers';
    if (h.get(`SELECT id FROM ${table} WHERE lower(name) = lower(?)`, name)) return fail(res, 409, 'That name is already listed.');
    const r = h.run(`INSERT INTO ${table} (name, city, is_sample) VALUES (?, ?, 0)`, name, city || null);
    audit(req.user.id, 'admin.org_added', kind + ':' + r.lastInsertRowid);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  // A college someone typed at sign-up: the admin confirms it (optionally correcting the name and city) so it is offered to everyone.
  app.post('/api/admin/orgs/:id/confirm', need('admin'), (req, res) => {
    const cur = h.get('SELECT * FROM institutions WHERE id = ?', +req.params.id); if (!cur) return fail(res, 404, 'Not found.');
    const name = req.body?.name === undefined ? cur.name : L.clean(req.body.name, 160), city = req.body?.city === undefined ? cur.city : L.clean(req.body.city, 80);
    if (!name || !city) return fail(res, 400, 'Give the college name and city.');
    if (h.all('SELECT id, name FROM institutions').some((i) => i.id !== cur.id && L.norm(i.name) === L.norm(name))) return fail(res, 409, 'Another college already has that name.');
    h.run('UPDATE institutions SET name = ?, city = ?, pending = 0 WHERE id = ?', name, city, cur.id);
    audit(req.user.id, 'admin.college_confirmed', cur.id); res.json({ ok: true });
  });
  // Body: { rows: [{ name, email, role, org, mentorEmail }] }. All rows are checked first; nothing is saved if any row is wrong.
  app.post('/api/admin/users', need('admin'), (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 1000) : [];
    if (!rows.length) return fail(res, 400, 'Add at least one person.');
    const errors = [], seen = new Set(), clean = [];
    const findOrg = (table, name) => h.get(`SELECT id FROM ${table} WHERE lower(name) = lower(?)`, String(name || '').trim());
    rows.forEach((r, i) => {
      if (!r || typeof r !== 'object') return errors.push(`Line ${i + 1}: could not be read.`);
      const line = i + 1, name = String(r.name || '').trim().slice(0, 120), email = String(r.email || '').trim().toLowerCase(), role = String(r.role || '').trim().toLowerCase().replace(/\s+/g, '_');
      if (!name) return errors.push(`Line ${line}: name is missing.`);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errors.push(`Line ${line}: "${email}" is not a valid email.`);
      if (seen.has(email) || h.get('SELECT id FROM users WHERE email = ?', email)) return errors.push(`Line ${line}: ${email} already has an account.`);
      if (!['student', 'mentor', 'college_admin', 'employer', 'researcher', 'admin'].includes(role)) return errors.push(`Line ${line}: role must be student, mentor, college_admin, employer, researcher or admin.`);
      let institution = null, employer = null;
      if (ORG_ROLES[role] === 'institution') { const o = findOrg('institutions', r.org); if (!o) return errors.push(`Line ${line}: college "${r.org || ''}" is not listed. Add it first.`); institution = o.id; }
      if (ORG_ROLES[role] === 'employer') { const o = findOrg('employers', r.org); if (!o) return errors.push(`Line ${line}: employer "${r.org || ''}" is not listed. Add it first.`); employer = o.id; }
      const mentorEmail = String(r.mentorEmail || '').trim().toLowerCase();
      if (mentorEmail && role !== 'student') return errors.push(`Line ${line}: only students have a mentor.`);
      seen.add(email); clean.push({ line, name, email, role, institution, employer, mentorEmail });
    });
    // Mentors may be in the same upload, so check mentor emails against both.
    for (const r of clean.filter((x) => x.mentorEmail)) {
      const inBatch = clean.find((x) => x.email === r.mentorEmail && x.role === 'mentor');
      const existing = h.get("SELECT id, institution_id FROM users WHERE email = ? AND role = 'mentor'", r.mentorEmail);
      const m = inBatch || existing;
      if (!m) errors.push(`Line ${r.line}: mentor ${r.mentorEmail} not found.`);
      else if ((inBatch ? inBatch.institution : existing.institution_id) !== r.institution) errors.push(`Line ${r.line}: mentor ${r.mentorEmail} is at a different college.`);
    }
    if (errors.length) return fail(res, 400, errors.slice(0, 20).join(' '));
    h.tx(() => {
      for (const r of clean) r.id = Number(h.run('INSERT INTO users (email, name, role, institution_id, employer_id, is_sample) VALUES (?, ?, ?, ?, ?, 0)', r.email, r.name, r.role, r.institution, r.employer).lastInsertRowid);
      for (const r of clean.filter((x) => x.mentorEmail)) {
        const m = h.get("SELECT id FROM users WHERE email = ? AND role = 'mentor'", r.mentorEmail);
        h.run('INSERT OR IGNORE INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', m.id, r.id);
      }
    });
    audit(req.user.id, 'admin.users_added', clean.length);
    // Without emailed codes, each new person gets a temporary password for the admin to hand over. It is shown only here.
    const passwords = emailCodes ? undefined : clean.map((r) => ({ name: r.name, email: r.email, password: auth.setTempPassword(r.id) }));
    res.status(201).json({ added: clean.length, passwords });
  });
  // Forgotten password: an admin gives the person a new temporary one, which they must change at their next sign-in.
  app.post('/api/admin/users/:id/reset-password', need('admin'), (req, res) => {
    const u = h.get('SELECT id, name, email FROM users WHERE id = ?', +req.params.id);
    if (!u) return fail(res, 404, 'Not found.');
    if (u.id === req.user.id) return fail(res, 400, 'Change your own password on your Account page.');
    const password = auth.setTempPassword(u.id);
    h.run('DELETE FROM login_failures WHERE email = ?', u.email);
    audit(req.user.id, 'admin.password_reset', u.id);
    res.json({ name: u.name, email: u.email, password });
  });

  // Set, change or clear a student's mentor. The mentor must be at the same college.
  app.put('/api/admin/users/:id/mentor', need('admin'), (req, res) => {
    const st = h.get("SELECT id, institution_id FROM users WHERE id = ? AND role = 'student'", +req.params.id);
    if (!st) return fail(res, 404, 'Not found.');
    const email = String(req.body?.mentorEmail || '').trim().toLowerCase();
    let m = null;
    if (email) {
      m = h.get("SELECT id, institution_id FROM users WHERE email = ? AND role = 'mentor'", email);
      if (!m) return fail(res, 400, `No mentor has the email ${email}.`);
      if (m.institution_id !== st.institution_id) return fail(res, 400, 'That mentor is at a different college.');
    }
    h.tx(() => { h.run('DELETE FROM mentor_links WHERE student_id = ?', st.id); if (m) h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', m.id, st.id); });
    audit(req.user.id, 'admin.mentor_' + (m ? 'set' : 'cleared'), st.id);
    res.json({ mentor: m ? email : null });
  });

  // Course catalogue and the course sites used for live searches.
  app.get('/api/admin/courses', need('admin'), (req, res) => res.json({ courses: h.all('SELECT * FROM courses ORDER BY id DESC'), sources: h.all('SELECT * FROM course_sources ORDER BY id') }));
  app.post('/api/admin/courses', need('admin'), (req, res) => {
    const b = req.body || {}, title = String(b.title || '').trim().slice(0, 200), provider = String(b.provider || '').trim().slice(0, 80), url = httpsUrl(b.url);
    const isComm = b.role === 'communication', idx = isComm ? null : Number(b.skillIndex);
    if (!title || !provider) return fail(res, 400, 'Give the course title and who provides it.');
    if (!url) return fail(res, 400, 'Give the full course link, starting with https://');
    if (!isComm && (!has(D.ROLES, b.role) || !(Number.isInteger(idx) && idx >= 0 && idx <= 3))) return fail(res, 400, 'Choose the role and skill this course teaches.');
    const weeks = b.weeks === '' || b.weeks == null ? null : Math.round(Number(b.weeks));
    if (weeks !== null && !(weeks >= 1 && weeks <= 104)) return fail(res, 400, 'Length in weeks must be from 1 to 104.');
    const r = h.run('INSERT INTO courses (title, provider, url, role, skill_index, weeks, free) VALUES (?, ?, ?, ?, ?, ?, ?)', title, provider, url, b.role, idx, weeks, b.free === false ? 0 : 1);
    audit(req.user.id, 'admin.course_added', r.lastInsertRowid);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  app.delete('/api/admin/courses/:id', need('admin'), (req, res) => {
    if (!h.run('DELETE FROM courses WHERE id = ?', +req.params.id).changes) return fail(res, 404, 'Not found.');
    audit(req.user.id, 'admin.course_removed', req.params.id); res.json({ removed: true });
  });
  app.post('/api/admin/course-sources', need('admin'), (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 60), tpl = String(req.body?.urlTemplate || '').trim().slice(0, 300);
    if (!name || !httpsUrl(tpl.replace('{q}', 'test')) || !tpl.includes('{q}')) return fail(res, 400, 'Give a name and a search address that starts with https:// and contains {q} where the skill goes.');
    if (h.get('SELECT 1 FROM course_sources WHERE lower(name) = lower(?)', name)) return fail(res, 409, 'That site is already listed.');
    h.run('INSERT INTO course_sources (name, url_template) VALUES (?, ?)', name, tpl);
    audit(req.user.id, 'admin.course_source_added', name); res.status(201).json({ ok: true });
  });
  app.delete('/api/admin/course-sources/:id', need('admin'), (req, res) => {
    if (!h.run('DELETE FROM course_sources WHERE id = ?', +req.params.id).changes) return fail(res, 404, 'Not found.');
    audit(req.user.id, 'admin.course_source_removed', req.params.id); res.json({ removed: true });
  });

  // Remove someone's account (for example when they leave, or ask for their data to be erased).
  app.delete('/api/admin/users/:id', need('admin'), (req, res) => {
    const u = h.get('SELECT id, email, role FROM users WHERE id = ?', +req.params.id);
    if (!u) return fail(res, 404, 'Not found.');
    if (u.id === req.user.id) return fail(res, 400, 'You cannot remove your own account.');
    removeAccount(u);
    audit(req.user.id, 'admin.account_removed', u.role + ':' + u.id);
    res.json({ removed: true });
  });

  // ---------- Frontend ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
  app.use('/api', (req, res) => fail(res, 404, 'Not found.'));
  app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html')));
  app.use((err, req, res, next) => { console.error(err); if (res.headersSent) return next(err); fail(res, err.status || 500, err.expose ? err.message : 'Something went wrong on our side. Try again.'); });

  return app;
}

module.exports = { createApp };
