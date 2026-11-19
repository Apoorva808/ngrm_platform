// GRM API and static frontend.
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
  // The AI first look at proof files. Tests pass their own; in the browser demo it is switched off.
  const proofChecker = opts.proofChecker || ai.checkProof;
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
    // A skill the student has not rated is stored as null: shown blank, never filled in for them.
    const raw = [0, 1, 2, 3].map((i) => parse(row.skills_json, [])[i] ?? null);
    const tvA = verifiedTransversal(row.user_id), tvSelf = D.TRANSVERSAL.map((_, i) => parse(row.transversal_json, [])[i] ?? null);
    return { prog: row.programme, year: row.year, cgpa: row.cgpa, cgpaConfirmed: !!row.cgpa_confirmed, class12: row.class12 ?? null, class12Confirmed: !!row.class12_confirmed, role: row.target_role, skills: raw.map((x) => x ?? 0), skillsRated: raw.map((x) => x != null), skillsVerified: [0, 1, 2, 3].map((i) => i in vs),
      transversal: tvSelf.map((v, i) => (i in tvA ? tvA[i] : v)), transversalOwn: tvSelf, transversalVerified: D.TRANSVERSAL.map((_, i) => i in tvA),
      ocean: oceanOf(row.ocean_json), clarity: row.clarity, otherRoles: parse(row.other_roles_json, []).filter((k) => has(D.ROLES, k) && k !== row.target_role).slice(0, 2) };
  }
  // Personality: the 20 questionnaire answers are stored; trait scores are worked out from them. Older records hold trait scores directly.
  function oceanOf(json) {
    const o = parse(json, null); if (!o) return null;
    if (Array.isArray(o.answers)) return D.ipipTraits(o.answers);
    return ['o', 'c', 'e', 'a', 'n'].every((k) => typeof o[k] === 'number') ? o : null;
  }
  const ipipAnswers = (json) => { const o = parse(json, null); return o && Array.isArray(o.answers) ? o.answers.map((a) => (Number.isInteger(a) && a >= 1 && a <= 5 ? a : null)) : D.IPIP.map(() => null); };
  // Transversal skills set by a mentor's assessment: { index: value }. An older communication assessment counts as the first.
  function verifiedTransversal(userId) {
    const out = {};
    for (const e of h.all("SELECT skill_index, skill_role, skill_value FROM evidence WHERE user_id = ? AND type = 'assessment' AND status = 'verified' AND skill_role IN ('transversal', 'communication') ORDER BY id", userId)) {
      const i = e.skill_role === 'communication' ? 0 : e.skill_index;
      if (Number.isInteger(i) && i >= 0 && i < D.TRANSVERSAL.length) out[i] = e.skill_value;
    }
    return out;
  }
  const aiCheckOf = (evId) => parse((h.get('SELECT ai_check_json FROM evidence WHERE id = ?', evId) || {}).ai_check_json, null);
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
  // Everything about this student that the plan is built from (see recommend() in domain.js).
  function planContext(userId, c) {
    const P = D.programme(c.p.prog), role = c.p.role, words = inWords(c.row);
    const u = h.get('SELECT institution_id FROM users WHERE id = ?', userId) || {};
    // Employers' posts for this role in the last 90 days: openings per scored skill, skills they typed, and posts in the student's cities.
    const posts = postsFor(role);
    const names = D.ROLES[role].skills.map(L.norm), bySkill = names.map(() => 0), extra = {}, mine = words.ownSkills.map((x) => L.norm(x.name)), cities = cityList(c.row);
    for (const d of posts) for (const k of d.skills) { const i = names.indexOf(L.norm(k)); if (i >= 0) bySkill[i] += d.openings; else { const key = L.norm(k); (extra[key] = extra[key] || { name: k, openings: 0 }).openings += d.openings; } }
    const cityPosts = cities.length ? posts.filter((d) => d.city && cities.some((x) => L.norm(d.city).includes(x))).map((d) => ({ employer: d.employer, city: d.city, openings: d.openings, source: d.source })) : [];
    // Students at the same college aiming for the same role (or, if too few, on the same programme): shares with each kind of verified evidence.
    // Shown only for groups of 5 or more, rounded to 5%, and only when the rest of the group is also 5 or more.
    let peers = null;
    for (const [col, val, label] of [['target_role', role, `students at your college aiming for ${D.ROLES[role].label}`], ['programme', c.p.prog, `${P.label} students at your college`]]) {
      const ids = h.all(`SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.role = 'student' AND u.institution_id = ? AND p.${col} = ? AND u.id != ?`, u.institution_id, val, userId).map((x) => x.id).filter((id) => hasConsent(id, 'profile'));
      if (ids.length < D.MIN_GROUP) continue;
      const has = {};
      for (const t of ['internship', 'project', 'role', 'certificate']) has[t] = safePct(h.get(`SELECT COUNT(DISTINCT user_id) AS n FROM evidence WHERE type = ? AND status = 'verified' AND user_id IN (${ids.map(() => '?').join(',')})`, t, ...ids).n, ids.length);
      peers = { label, n: approx(ids.length), has }; break;
    }
    let goal = null;
    if (words.goal) { const f = L.familyOf(words.goal); if (f.k !== 'general') { const k = Object.keys(D.ROLES).find((x) => D.ROLES[x].family === f.k && D.ROLES[x].listed); goal = { text: words.goal, family: f.k, roleLabel: k ? D.ROLES[k].label : f.name }; } }
    return { yearsLeft: Math.max(0, P.years - c.p.year), words, goal, peers, psyConsent: hasConsent(userId, 'psychometric'),
      demand: { bySkill, cityPosts, extra: Object.values(extra).sort((a, b) => b.openings - a.openings).map((k) => ({ ...k, have: mine.includes(L.norm(k.name)) })) } };
  }
  function recsFor(userId) {
    const c = computeFor(userId); if (!c) return null;
    const ctx = planContext(userId, c);
    const list = D.recommend(c.p, c.ev, ruleSettings(), ctx);
    const states = {}; for (const s of h.all('SELECT * FROM recommendation_states WHERE user_id = ?', userId)) states[s.rule_id] = s;
    return { c, ctx, list: list.map((r) => ({ ...r, state: states[r.id] || null, learn: learnFor(r, c.p) })) };
  }
  // Where to learn: vetted courses from the catalogue plus live searches on course sites, for the exact skill in the step.
  const httpsUrl = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
  function learnFor(item, p) {
    const ruleId = item.id;
    if (ruleId === 'demand' && item.skillName) {
      const searches = h.all('SELECT name, url_template FROM course_sources ORDER BY id').map((s) => ({ name: s.name, url: httpsUrl(s.url_template.replace('{q}', encodeURIComponent(item.skillName))) })).filter((s) => s.url);
      const live = feeds.forSkill(item.skillName);
      return { skill: item.skillName, courses: [], searches, live: live.courses, liveCheckedAt: live.checkedAt, demand: null };
    }
    if (ruleId !== 'course' && ruleId !== 'transversal') return null;
    let courses, skill, idx = null;
    if (ruleId === 'course') {
      idx = item.skillIndex ?? D.weakest(p); skill = D.ROLES[p.role].skills[idx];
      courses = h.all('SELECT id, title, provider, url, weeks, free FROM courses WHERE role = ? AND skill_index = ? ORDER BY id DESC LIMIT 5', p.role, idx);
    } else {
      const t = item.tskill ?? 0; skill = D.TRANSVERSAL[t];
      // Courses catalogued for a transversal skill; older catalogue entries for communication count as the first.
      courses = h.all("SELECT id, title, provider, url, weeks, free FROM courses WHERE (role = 'transversal' AND skill_index = ?) OR (? = 0 AND role = 'communication') ORDER BY id DESC LIMIT 5", t, t);
    }
    const searches = h.all('SELECT name, url_template FROM course_sources ORDER BY id').map((s) => ({ name: s.name, url: httpsUrl(s.url_template.replace('{q}', encodeURIComponent(skill))) })).filter((s) => s.url);
    const live = feeds.forSkill(skill);
    return { skill, courses, searches, live: live.courses, liveCheckedAt: live.checkedAt, demand: ruleId === 'course' ? demandFor(p.role)[idx] : null };
  }
  // Openings for a role in the last 90 days: what employers posted on GRM, and what the team added from public sources (named and linked).
  function postsFor(role) {
    const own = h.all("SELECT d.skills_json, d.extra_json, d.openings, d.city, d.created_at, e.name AS employer FROM demand_posts d JOIN employers e ON e.id = d.employer_id WHERE d.role = ? AND d.created_at > datetime('now', '-90 days') ORDER BY d.id DESC", role)
      .map((d) => ({ employer: d.employer, city: d.city, openings: d.openings, postedAt: d.created_at, skills: parse(d.skills_json, []).concat(parse(d.extra_json, [])), source: null, url: null }));
    const found = h.all("SELECT title, organisation, skills_json, openings, city, source_name, source_url, source_kind, COALESCE(posted_on, date(created_at)) AS posted FROM public_openings WHERE role = ? AND COALESCE(posted_on, date(created_at)) > date('now', '-90 days') ORDER BY id DESC", role)
      .map((d) => ({ employer: d.organisation, title: d.title, city: d.city, openings: d.openings, postedAt: d.posted, skills: parse(d.skills_json, []), source: d.source_name, sourceKind: D.SOURCE_KINDS[d.source_kind] || null, url: httpsUrl(d.source_url) }));
    return own.concat(found);
  }
  // What employers are asking for, per skill of a role, from openings in the last 90 days.
  function demandFor(role) {
    const names = D.ROLES[role].skills, out = names.map((name) => ({ skill: name, openings: 0, posts: 0 }));
    for (const d of postsFor(role)) for (const k of d.skills) { const i = names.map(L.norm).indexOf(L.norm(k)); if (i >= 0) { out[i].openings += d.openings; out[i].posts++; } }
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
  // ---------- Mentors for every student ----------
  // A student with no mentor cannot have anything confirmed, so nobody is left without one when their college has mentors:
  // each new student goes to the mentor at their college with the fewest students.
  // A college mentor is a mentor at the student's own college. Volunteer mentors (no college) come on top, only when a student asks.
  const hasCollegeMentor = (st) => !!h.get('SELECT 1 FROM mentor_links l JOIN users m ON m.id = l.mentor_id WHERE l.student_id = ? AND m.institution_id = ?', st.id, st.institution_id);
  function giveMentor(studentId) {
    const st = h.get("SELECT id, institution_id FROM users WHERE id = ? AND role = 'student'", studentId);
    if (!st || !st.institution_id || hasCollegeMentor(st)) return false;
    const m = h.get("SELECT u.id FROM users u WHERE u.role = 'mentor' AND u.institution_id = ? ORDER BY (SELECT COUNT(*) FROM mentor_links l WHERE l.mentor_id = u.id), u.id LIMIT 1", st.institution_id);
    if (!m) return false;
    h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', m.id, st.id); return true;
  }
  const unmentored = (instId) => h.all("SELECT u.id FROM users u WHERE u.role = 'student' AND u.institution_id = ? AND NOT EXISTS (SELECT 1 FROM mentor_links l JOIN users m ON m.id = l.mentor_id WHERE l.student_id = u.id AND m.institution_id = u.institution_id) ORDER BY u.id", instId);
  const shareOut = (instId) => h.tx(() => unmentored(instId).filter((s) => giveMentor(s.id)).length);
  // The placement cell sees how its mentors are loaded and can share out students who have none. No student is named.
  const mentoring = (instId) => ({ mentors: h.all("SELECT u.name, (SELECT COUNT(*) FROM mentor_links l WHERE l.mentor_id = u.id) AS students FROM users u WHERE u.role = 'mentor' AND u.institution_id = ? ORDER BY u.name", instId), withoutMentor: unmentored(instId).length,
    withVolunteer: h.get("SELECT COUNT(DISTINCT l.student_id) AS n FROM mentor_links l JOIN volunteers v ON v.user_id = l.mentor_id JOIN users u ON u.id = l.student_id WHERE u.institution_id = ?", instId).n });

  // ---------- Volunteer mentors ----------
  // People from industry, government and education who give their time free. They can review plans, check proof and assess
  // skills, but only a mentor at the student's college can confirm marks against college records.
  // Volunteer mentors have no college, so the college views are not for them.
  const atCollege = (req, res, next) => (req.user.institution_id ? next() : fail(res, 403, 'This view is for mentors and placement cells at a college.'));
  const isVolunteer = (userId) => !!h.get('SELECT 1 FROM volunteers WHERE user_id = ?', userId);
  function volunteerDetails(b) {
    const sector = String(b.sector || '');
    if (!has(D.SECTORS, sector)) return { error: 'Choose the sector you work in: industry, government, education or other.' };
    const organisation = L.clean(b.volOrg ?? b.organisation, 120);
    if (!organisation || organisation.length < 2) return { error: 'Type where you work, or worked last.' };
    const expertise = [];
    for (const x of String(Array.isArray(b.expertise) ? b.expertise.join(',') : b.expertise || '').split(/[,;\n]/)) { const t = L.clean(x, 40); if (t && !expertise.some((k) => L.norm(k) === L.norm(t))) expertise.push(t); }
    if (!expertise.length) return { error: 'Type at least one area you can guide students in, for example data analysis or civil services.' };
    if (expertise.length > 5) return { error: 'Type up to 5 areas you can guide students in.' };
    const capacity = b.capacity === undefined || b.capacity === null || b.capacity === '' ? 10 : Number(b.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 30) return { error: 'Say how many students you can take on, from 1 to 30.' };
    return { sector, organisation, expertise, capacity };
  }
  const saveVolunteer = (userId, v) => h.run('INSERT OR REPLACE INTO volunteers (user_id, sector, organisation, expertise_json, capacity) VALUES (?, ?, ?, ?, ?)', userId, v.sector, v.organisation, JSON.stringify(v.expertise), v.capacity);
  const volunteerOf = (userId) => { const v = h.get('SELECT * FROM volunteers WHERE user_id = ?', userId); return v ? { sector: v.sector, sectorLabel: D.SECTORS[v.sector], organisation: v.organisation, expertise: parse(v.expertise_json, []), capacity: v.capacity } : null; };
  // The volunteer with room whose areas best match what the student is aiming for (role, its skills, their goal and interests).
  function pickVolunteer(studentId) {
    const row = profileRow(studentId) || {}, R = D.ROLES[row.target_role];
    // Words of the role's name count three times as much as words from its skills or the student's goal and interests.
    const words = (t) => L.norm(t).split(' ').filter((w) => w.length > 1 && !['and', 'the', 'for', 'with'].includes(w));
    const wanted = new Map(); for (const w of words([R ? R.skills.join(' ') : '', row.goal || '', row.interests || ''].join(' '))) wanted.set(w, 1);
    for (const w of words(R ? R.label : '')) wanted.set(w, 3);
    const list = h.all("SELECT v.user_id AS id, v.capacity, v.expertise_json, (SELECT COUNT(*) FROM mentor_links l WHERE l.mentor_id = v.user_id) AS n FROM volunteers v JOIN users u ON u.id = v.user_id WHERE u.role = 'mentor'")
      .filter((v) => v.n < v.capacity)
      .map((v) => ({ ...v, match: parse(v.expertise_json, []).reduce((t, x) => t + words(x).reduce((u, w) => u + (wanted.get(w) || 0), 0), 0) }))
      .sort((a, b) => b.match - a.match || a.n / a.capacity - b.n / b.capacity || a.id - b.id);
    return list[0] || null;
  }
  const myVolunteer = (studentId) => h.get('SELECT l.mentor_id AS id FROM mentor_links l JOIN volunteers v ON v.user_id = l.mentor_id WHERE l.student_id = ?', studentId);
  app.get('/api/me/mentors', need('student'), (req, res) => {
    const list = h.all('SELECT u.id, u.name, u.institution_id FROM mentor_links l JOIN users u ON u.id = l.mentor_id WHERE l.student_id = ? ORDER BY u.institution_id IS NULL, u.name', req.user.id)
      .map((m) => { const v = volunteerOf(m.id); return v ? { name: m.name, kind: 'volunteer', sector: v.sectorLabel, organisation: v.organisation, expertise: v.expertise } : { name: m.name, kind: 'college' }; });
    res.json({ mentors: list, volunteerRoom: !myVolunteer(req.user.id) && !!pickVolunteer(req.user.id) });
  });
  app.post('/api/me/volunteer-mentor', need('student'), (req, res) => {
    if (!hasConsent(req.user.id, 'profile')) return fail(res, 403, 'consent_required:profile');
    if (myVolunteer(req.user.id)) return fail(res, 409, 'You already have a volunteer mentor. End that first if you want someone else.');
    const v = pickVolunteer(req.user.id);
    if (!v) return fail(res, 409, 'No volunteer mentor has room right now. Try again in a few days.');
    h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', v.id, req.user.id);
    audit(req.user.id, 'student.volunteer_asked', v.id);
    const u = h.get('SELECT name FROM users WHERE id = ?', v.id), d = volunteerOf(v.id);
    res.status(201).json({ name: u.name, sector: d.sectorLabel, organisation: d.organisation, expertise: d.expertise });
  });
  app.delete('/api/me/volunteer-mentor', need('student'), (req, res) => {
    const v = myVolunteer(req.user.id); if (!v) return fail(res, 404, 'You do not have a volunteer mentor.');
    h.run('DELETE FROM mentor_links WHERE mentor_id = ? AND student_id = ?', v.id, req.user.id);
    audit(req.user.id, 'student.volunteer_ended', v.id); res.json({ ok: true });
  });
  app.get('/api/admin/volunteers', need('admin'), (req, res) => res.json(h.all("SELECT u.id, u.name, u.email, v.sector, v.organisation, v.expertise_json, v.capacity, (SELECT COUNT(*) FROM mentor_links l WHERE l.mentor_id = u.id) AS students, (SELECT COALESCE(SUM(minutes), 0) FROM mentor_sessions s WHERE s.mentor_id = u.id) AS minutes FROM volunteers v JOIN users u ON u.id = v.user_id ORDER BY u.name")
    .map(({ expertise_json, ...v }) => ({ ...v, sectorLabel: D.SECTORS[v.sector], expertise: parse(expertise_json, []) }))));

  // ---------- Mentoring hours and the certificate ----------
  const dayOk = (t) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t))) return false; const d = new Date(t + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t; };
  const sessionTotals = (mentorId) => h.get('SELECT COUNT(*) AS sessions, COALESCE(SUM(minutes), 0) AS minutes, COUNT(DISTINCT student_id) AS students, MIN(held_on) AS from_date, MAX(held_on) AS to_date FROM mentor_sessions WHERE mentor_id = ?', mentorId);
  app.get('/api/mentor/sessions', need('mentor'), (req, res) => res.json({
    sessions: h.all('SELECT s.id, s.held_on, s.minutes, s.kind, s.note, u.name AS student FROM mentor_sessions s LEFT JOIN users u ON u.id = s.student_id WHERE s.mentor_id = ? ORDER BY s.held_on DESC, s.id DESC LIMIT 100', req.user.id),
    totals: sessionTotals(req.user.id),
    certificates: h.all('SELECT code, minutes, sessions, students, from_date, to_date, issued_at FROM certificates WHERE mentor_id = ? ORDER BY issued_at DESC', req.user.id) }));
  app.post('/api/mentor/sessions', need('mentor'), (req, res) => {
    const b = req.body || {}, kind = String(b.kind || ''), minutes = Number(b.minutes), on = String(b.heldOn || '');
    if (!has(D.SESSION_KINDS, kind)) return fail(res, 400, 'Choose what kind of time this was.');
    if (!dayOk(on)) return fail(res, 400, 'Type the date it happened, for example 12 Nov 2026.');
    const t = new Date(on + 'T00:00:00Z').getTime();
    if (t > Date.now()) return fail(res, 400, 'The date cannot be in the future.');
    if (t < Date.now() - 366 * 864e5) return fail(res, 400, 'Log time within a year of when it happened.');
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) return fail(res, 400, 'Give the time in minutes, from 5 to 480.');
    let sid = null;
    if (b.studentId !== undefined && b.studentId !== null && b.studentId !== '') { sid = Number(b.studentId); if (!isMentee(req.user.id, sid)) return fail(res, 400, 'That student is not your mentee.'); }
    if (kind === 'one_to_one' && !sid) return fail(res, 400, 'Say which mentee the one-to-one session was with.');
    const r = h.run('INSERT INTO mentor_sessions (mentor_id, student_id, held_on, minutes, kind, note) VALUES (?, ?, ?, ?, ?, ?)', req.user.id, sid, on, minutes, kind, L.clean(b.note, 200) || null);
    audit(req.user.id, 'mentor.session_logged', r.lastInsertRowid);
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid), totals: sessionTotals(req.user.id) });
  });
  app.delete('/api/mentor/sessions/:id', need('mentor'), (req, res) => {
    const r = h.run('DELETE FROM mentor_sessions WHERE id = ? AND mentor_id = ?', +req.params.id, req.user.id);
    if (!r.changes) return fail(res, 404, 'Not found.');
    audit(req.user.id, 'mentor.session_removed', +req.params.id); res.json({ ok: true, totals: sessionTotals(req.user.id) });
  });
  // A certificate is a snapshot of the hours logged so far, with a code anyone can check on the certificate page.
  app.post('/api/mentor/certificate', need('mentor'), (req, res) => {
    const t = sessionTotals(req.user.id);
    if (t.minutes < 60) return fail(res, 409, 'Log at least one hour of mentoring before asking for a certificate.');
    const v = volunteerOf(req.user.id), inst = req.user.institution_id ? h.get('SELECT name FROM institutions WHERE id = ?', req.user.institution_id) : null;
    const description = v ? `Volunteer mentor (${v.sectorLabel.toLowerCase()}, ${v.organisation})` : `Faculty mentor, ${inst ? inst.name : 'college not given'}`;
    const code = 'GRM-' + crypto.randomBytes(5).toString('hex').toUpperCase();
    h.run('INSERT INTO certificates (code, mentor_id, name, description, minutes, sessions, students, from_date, to_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', code, req.user.id, req.user.name, description, t.minutes, t.sessions, t.students, t.from_date, t.to_date);
    audit(req.user.id, 'mentor.certificate_issued', code);
    res.status(201).json({ code });
  });
  // Public: anyone holding the code can check a certificate. Nothing about students is shown.
  app.get('/api/certificates/:code', (req, res) => {
    if (ipLimited(req, res, 'cert', 60)) return;
    const c = h.get('SELECT code, name, description, minutes, sessions, students, from_date, to_date, issued_at FROM certificates WHERE code = ?', String(req.params.code || '').trim().toUpperCase());
    if (!c) return fail(res, 404, 'No certificate has that code. Check it against the certificate.');
    res.json(c);
  });
  app.get('/api/college/mentoring', need('college_admin'), (req, res) => res.json(mentoring(req.user.institution_id)));
  app.post('/api/college/mentoring/share', need('college_admin'), (req, res) => {
    if (!h.get("SELECT 1 FROM users WHERE role = 'mentor' AND institution_id = ?", req.user.institution_id)) return fail(res, 409, 'No mentor at your college has an GRM account yet. Ask your faculty mentors to create one; the GRM admin approves it.');
    const shared = shareOut(req.user.institution_id);
    audit(req.user.id, 'college.mentors_shared', shared);
    res.json({ shared, ...mentoring(req.user.institution_id) });
  });

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
  // Type a role: an existing one with the same name is reused, otherwise a new one is made from its role family.
  // "Data Analysts" and "data analyst" are the same role.
  const sameRole = (made) => { const one = (t) => L.norm(t).replace(/s$/, ''); return Object.keys(D.ROLES).find((k) => one(D.ROLES[k].label) === one(made.label) || k === made.key) || null; };
  function resolveRole(text, user) {
    const made = L.makeRole(text);
    if (!made) return { error: 'Type the role as you would say it, for example "Data Scientist".', status: 400 };
    const same = sameRole(made); if (same) return { key: same, created: false };
    if (user.role === 'student' && typedToday('custom_roles', user.id) >= 8) return { error: 'You have added several new roles today. Choose one of them or try again tomorrow.', status: 429 };
    h.run('INSERT INTO custom_roles (key, label, family, skills_json, targets_json, project, internship, needs_review, listed, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      made.key, made.label, made.family, JSON.stringify(made.skills), JSON.stringify(made.target), made.project, made.internship, made.needsReview ? 1 : 0, user.role === 'student' ? 0 : 1, user.id);
    audit(user.id, 'library.role_typed', made.key); loadLibrary();
    return { key: made.key, created: true };
  }
  function resolveProgramme(text, user) {
    const made = L.makeProgramme(text);
    if (!made) return { error: 'Type the programme as it appears on the marks card, for example "B.Sc. Physics".', status: 400 };
    const same = D.PROGRAMMES.find((p) => L.norm(p.label) === L.norm(made.label) || p.id === made.id);
    if (same) return { id: same.id, created: false };
    if (user.role === 'student' && typedToday('custom_programmes', user.id) >= 8) return { error: 'You have added several new programmes today. Choose one of them or try again tomorrow.', status: 429 };
    h.run('INSERT INTO custom_programmes (id, label, years, discipline, listed, created_by) VALUES (?, ?, ?, ?, ?, ?)', made.id, made.label, made.years, made.discipline, user.role === 'student' ? 0 : 1, user.id);
    audit(user.id, 'library.programme_typed', made.id); loadLibrary();
    return { id: made.id, created: true };
  }
  app.post('/api/library/role', need(), (req, res) => {
    const r = resolveRole(req.body?.text, req.user);
    if (r.error) return fail(res, r.status, r.error);
    res.status(r.created ? 201 : 200).json({ key: r.key, role: D.ROLES[r.key], created: r.created });
  });
  app.post('/api/library/programme', need(), (req, res) => {
    const r = resolveProgramme(req.body?.text, req.user);
    if (r.error) return fail(res, r.status, r.error.replace('the marks card', 'your marks card'));
    res.status(r.created ? 201 : 200).json({ id: r.id, programme: D.programme(r.id), created: r.created });
  });
  // The placement cell says which roles each of its programmes usually leads to. Students of that programme see them as ideas.
  const programmeRoles = (instId) => {
    const out = {};
    for (const r of h.all('SELECT programme, role_key FROM programme_roles WHERE institution_id = ? ORDER BY programme, position', instId)) if (D.ROLES[r.role_key]) (out[r.programme] = out[r.programme] || []).push({ key: r.role_key, label: D.ROLES[r.role_key].label });
    return Object.keys(out).map((p) => ({ programme: p, label: D.programme(p).label, roles: out[p] })).sort((a, b) => a.label.localeCompare(b.label));
  };
  app.get('/api/college/programme-roles', need('college_admin', 'mentor'), atCollege, (req, res) => res.json(programmeRoles(req.user.institution_id)));
  app.put('/api/college/programme-roles', need('college_admin'), (req, res) => {
    const b = req.body || {};
    const P = b.programmeId && D.PROGRAMMES.find((p) => p.id === b.programmeId) ? { id: b.programmeId } : resolveProgramme(b.programme, req.user);
    if (P.error) return fail(res, P.status, P.error);
    const typed = (Array.isArray(b.roles) ? b.roles : String(b.roles || '').split(/[,;\n]/)).map((x) => L.clean(x, 60)).filter(Boolean);
    if (typed.length > 5) return fail(res, 400, 'Type up to 5 roles for a programme.');
    const keys = [];
    for (const t of typed) { const r = resolveRole(t, req.user); if (r.error) return fail(res, r.status, `"${t}": ${r.error}`); if (!keys.includes(r.key)) keys.push(r.key); }
    h.tx(() => {
      h.run('DELETE FROM programme_roles WHERE institution_id = ? AND programme = ?', req.user.institution_id, P.id);
      keys.forEach((k, i) => h.run('INSERT INTO programme_roles (institution_id, programme, role_key, position) VALUES (?, ?, ?, ?)', req.user.institution_id, P.id, k, i));
    });
    audit(req.user.id, 'college.programme_roles_set', P.id + ':' + keys.length);
    res.json(programmeRoles(req.user.institution_id));
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
    formulaVersion: D.FORMULA_VERSION, minGroup: D.MIN_GROUP, factors: D.FACTORS, groups: D.GROUPS, transversal: D.TRANSVERSAL, half: D.HALF,
    ipip: D.IPIP.map((x) => x.t), ipipScale: D.IPIP_SCALE, traitNames: D.TRAIT_NAMES, ...libraryFor(req.user), fitLabels: L.FIT_LABEL,
    evidenceTypes: D.EVIDENCE_TYPES, slots: D.SLOTS, consentPurposes: D.CONSENT_PURPOSES, sectors: D.SECTORS, sessionKinds: D.SESSION_KINDS, sourceKinds: D.SOURCE_KINDS, demoMode, signUp: signUpOpen, emailCodes,
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
    if (hits.length >= max) { fail(res, 429, kind === 'code' ? 'Too many sign-in codes asked for from this network. Try again in an hour.' : kind === 'cert' ? 'Too many certificate checks from this network. Try again in an hour.' : 'Too many accounts created from this network in the last hour. Try again later.'); return true; }
    hits.push(now); ipHits.set(ip, hits);
    if (ipHits.size > 10000) for (const [k, v] of ipHits) if (!v.some((t) => now - t < 60 * 60 * 1000)) ipHits.delete(k);
    return false;
  }
  // Sign-up. Anyone can ask; the emailed code proves the address. Students get an account at once,
  // mentors, placement cells, employers and researchers wait for an admin, and admins are never created this way.
  app.get('/api/auth/sign-up-options', (req, res) => res.json({ open: signUpOpen, domains: signUpDomains,
    institutions: signUpOpen ? h.all('SELECT id, name, city FROM institutions WHERE pending = 0 ORDER BY name') : [] }));
  app.post('/api/auth/sign-up', (req, res) => {
    if (!signUpOpen) return fail(res, 403, 'Sign-up is closed. Ask your college or the GRM team for an account.');
    const b = req.body || {}, name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 120), email = String(b.email || '').trim().toLowerCase(), role = String(b.role || '');
    if (name.length < 2) return fail(res, 400, 'Enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail(res, 400, 'Enter a valid email address.');
    if (!SIGNUP_ROLES.includes(role) && role !== 'volunteer') return fail(res, 400, 'Choose who you are signing up as.');
    let institutionId = null, orgName = null, newCollege = null, extra = null;
    // A volunteer mentor is a mentor account with no college, approved by the admin like any mentor.
    if (role === 'volunteer') { const v = volunteerDetails(b); if (v.error) return fail(res, 400, v.error); extra = { volunteer: v }; orgName = v.organisation; }
    const asRole = role === 'volunteer' ? 'mentor' : role;
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
      const r = auth.signUpStart({ name, email, role: asRole, institutionId: withCollege(), orgName, password: b.password, extra });
      if (r.error) return fail(res, r.status, r.error);
      return res.json(r);
    }
    // Without codes the account is made at once. A whole college lab may share one address, so the limit is generous.
    if (ipLimited(req, res, 'signup', 120)) return;
    const bad = auth.passwordProblem(b.password, email); if (bad) return fail(res, 400, bad);
    if (h.get('SELECT 1 FROM users WHERE email = ?', email)) return fail(res, 409, 'This email already has an account. Sign in instead.');
    const r = auth.signUpDirect({ name, email, role: asRole, institutionId: withCollege(), orgName, password: b.password, extra });
    if (r.error) return fail(res, r.status, r.error);
    if (r.pending) return res.json({ pending: true });
    giveMentor(r.user.id);
    setCookie(res, r.token); res.json({ user: { id: r.user.id, name: r.user.name, role: r.user.role } });
  });
  app.post('/api/auth/sign-up/verify', (req, res) => {
    if (!emailCodes) return fail(res, 404, 'Not available.');
    const r = auth.signUpVerify(req.body?.email, req.body?.code);
    if (r.error) return fail(res, 400, r.error);
    if (r.pending) return res.json({ pending: true });
    giveMentor(r.user.id);
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
    if (r.error && r.status === 400 && auth.waitingWith(req.body?.email, req.body?.password)) return fail(res, 403, 'Your email is confirmed and your account is waiting for approval by the GRM admin. You will be able to sign in once it is approved.');
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
    res.json(h.all("SELECT u.email, u.name, u.role, EXISTS (SELECT 1 FROM volunteers v WHERE v.user_id = u.id) AS volunteer FROM users u WHERE u.email LIKE '%@demo.grm.in' ORDER BY CASE u.role WHEN 'student' THEN 1 WHEN 'mentor' THEN 2 WHEN 'college_admin' THEN 3 WHEN 'employer' THEN 4 WHEN 'researcher' THEN 5 ELSE 6 END"));
  });
  app.post('/api/auth/demo', (req, res) => {
    if (!demoMode) return fail(res, 404, 'Not available.');
    const u = h.get("SELECT * FROM users WHERE email = ? AND email LIKE '%@demo.grm.in'", String(req.body?.email || ''));
    if (!u) return fail(res, 400, 'Unknown demo account.');
    setCookie(res, auth.startSession(u.id)); res.json({ user: { id: u.id, name: u.name, role: u.role } });
  });
  app.post('/api/auth/sign-out', (req, res) => { auth.endSession(req.token); res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => {
    if (!req.user) return res.json({ user: null });
    const u = req.user;
    const inst = u.institution_id ? h.get('SELECT name, city FROM institutions WHERE id = ?', u.institution_id) : null;
    const emp = u.employer_id ? h.get('SELECT name FROM employers WHERE id = ?', u.employer_id) : null;
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role, institution: inst, employer: emp, hasPassword: auth.hasPassword(u.id), signedInWith: u.via, mustChangePassword: !!u.mustChange, volunteer: u.role === 'mentor' ? volunteerOf(u.id) : undefined }, consents: u.role === 'student' ? consents(u.id) : undefined });
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
    if (purposes.ai_proof_check === false) h.run('UPDATE evidence SET ai_check_json = NULL WHERE user_id = ?', req.user.id);
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
      if (!c) lines.push(hasConsent(u.id, 'profile') ? 'Type your programme, year and aspired role on My score to begin. Nothing is filled in for you.' : 'Start by choosing what GRM may store.');
      else {
        lines.push(`${D.programme(c.p.prog).label}, aiming for ${D.ROLES[c.p.role].label} · ${D.pathNote(c.p).label.toLowerCase()} · score ${c.result.index.toFixed(1)}`);
        const half = []; if (c.result.flags.cgpaUnconfirmed) half.push(c.result.flags.marksFrom === 'class12' ? 'your Class 12 marks' : 'your CGPA'); const rated = c.p.skills.filter((_, i) => c.p.skillsRated[i] && !c.p.skillsVerified[i]).length; if (rated) half.push(plural(rated, 'role skill', 'role skills'));
        if (c.result.flags.transversalUnassessed) half.push(plural(c.result.flags.transversalUnassessed, 'transversal skill', 'transversal skills'));
        const pend = n("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND status = 'pending'", u.id); if (pend) half.push(plural(pend, 'evidence item', 'evidence items'));
        if (half.length) lines.push('Counting at half until your mentor confirms them: ' + half.join(', ') + '. You do not need to wait; keep going with your plan.');
        if (c.result.flags.psychometricMissing && hasConsent(u.id, 'psychometric')) lines.push('The 20-question personality questionnaire on My score is still to do.');
        const proof = n("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND status = 'needs_proof'", u.id); if (proof) lines.push(`Your mentor asked for proof on ${plural(proof, 'item', 'items')}.`);
        const todo = ownSteps(u.id).filter((s) => !s.done).length; if (todo) lines.push(`${plural(todo, 'step', 'steps')} of your own still to do.`);
        if (!c.row.goal) lines.push('Tell GRM your goal in your own words on My score, and your plan will follow it.');
      }
    } else if (u.role === 'mentor') {
      const ids = h.all('SELECT student_id AS id FROM mentor_links WHERE mentor_id = ?', u.id).map((x) => x.id).filter((id) => hasConsent(id, 'profile'));
      let cg = 0, sk = 0, ev = 0;
      for (const id of ids) { const c = computeFor(id); if (!c) continue; if (c.result.flags.cgpaUnconfirmed) cg++; if (c.p.skills.some((_, i) => c.p.skillsRated[i] && !c.p.skillsVerified[i]) || c.result.flags.transversalUnassessed) sk++; ev += n("SELECT COUNT(*) AS n FROM evidence WHERE user_id = ? AND status = 'pending'", id); }
      lines.push(`You mentor ${plural(ids.length, 'student', 'students')}.`);
      const idle = ids.filter((id) => !profileRow(id)).length + h.all('SELECT student_id AS id FROM mentor_links WHERE mentor_id = ?', u.id).filter((x) => !hasConsent(x.id, 'profile')).length;
      if (idle) lines.push(`${plural(idle, 'has', 'have')} not started a profile yet.`);
      const wait = []; if (ev) wait.push(plural(ev, 'evidence item', 'evidence items') + ' to verify'); if (cg) wait.push(plural(cg, 'CGPA or Class 12 mark', 'CGPAs or Class 12 marks') + ' to confirm'); if (sk) wait.push(plural(sk, 'student', 'students') + ' with ratings to assess');
      lines.push(wait.length ? 'When you have time: ' + wait.join(', ') + '. Students are not blocked meanwhile; these count at half until you confirm them.' : 'Nothing is waiting for you.');
    } else if (u.role === 'college_admin') {
      const inst = h.get('SELECT name FROM institutions WHERE id = ?', u.institution_id) || { name: 'your college' };
      const st = n("SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND institution_id = ?", u.institution_id), noMentor = n("SELECT COUNT(*) AS n FROM users u WHERE u.role = 'student' AND u.institution_id = ? AND NOT EXISTS (SELECT 1 FROM mentor_links l WHERE l.student_id = u.id)", u.institution_id);
      lines.push(`${inst.name}: ${plural(st, 'student', 'students')} on GRM.`);
      if (noMentor) lines.push(`${plural(noMentor, 'student has', 'students have')} no mentor yet, so nothing they enter can be confirmed. Share them among your mentors below.`);
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
    const psy = hasConsent(userId, 'psychometric');
    return { profile: { ...c.p, optInIntros: !!c.row.opt_in_intros, verifiedSkills: verified }, mine: inWords(c.row), interestRoles: interestRoles(c.row, c.p), path: D.pathNote(c.p), score: c.result, band: D.band(c.result.index), lastRecorded: last || null,
      ipip: psy ? { answers: ipipAnswers(c.row.ocean_json), traits: c.p.ocean } : null, compare: compareRoles(userId, c), collegeRoles: collegeRolesFor(userId, c) };
  }
  // Roles the student's placement cell says their programme usually leads to, other than the ones they already chose.
  function collegeRolesFor(userId, c) {
    const inst = (h.get('SELECT institution_id FROM users WHERE id = ?', userId) || {}).institution_id; if (!inst) return [];
    const chosen = [c.p.role].concat(c.p.otherRoles);
    return h.all('SELECT role_key FROM programme_roles WHERE institution_id = ? AND programme = ? ORDER BY position', inst, c.p.prog).map((r) => r.role_key).filter((k) => D.ROLES[k] && !chosen.includes(k)).map((k) => ({ key: k, label: D.ROLES[k].label }));
  }
  // The student's main aspired role and up to two more, side by side: how their programme leads to each, which of each role's
  // skills they already show, and how many openings there were in the last 90 days. Skills are matched by name.
  function compareRoles(userId, c) {
    const known = {};
    D.ROLES[c.p.role].skills.forEach((k, i) => { if (c.p.skillsVerified[i]) known[L.norm(k)] = { v: c.p.skills[i], how: 'assessed' }; else if (c.p.skillsRated[i]) known[L.norm(k)] = { v: c.p.skills[i], how: 'your rating' }; });
    for (const s of inWords(c.row).ownSkills) if (!known[L.norm(s.name)]) known[L.norm(s.name)] = { v: s.level, how: 'your own skills' };
    return [c.p.role].concat(c.p.otherRoles).map((k, n) => {
      const R = D.ROLES[k], fit = D.fitOf({ ...c.p, role: k });
      const skills = R.skills.map((name) => { const m = known[L.norm(name)]; return { name, value: m ? m.v : null, how: m ? m.how : null }; });
      const match = Math.round(skills.reduce((t, x) => t + (x.value == null ? 0 : x.how === 'assessed' ? +x.value : +x.value * D.HALF), 0) / skills.length);
      return { key: k, label: R.label, main: n === 0, fit, fitLabel: L.FIT_LABEL[fit], skills, match, openings: postsFor(k).reduce((t, p) => t + p.openings, 0) };
    });
  }
  // Withdrawing questionnaire consent removes the answers everywhere they were kept, including recorded scores and the study baseline.
  function scrubPsychometric(userId) {
    h.tx(() => {
      h.run('UPDATE profiles SET ocean_json = NULL WHERE user_id = ?', userId);
      for (const r of h.all('SELECT id, inputs_json, factors_json FROM score_runs WHERE user_id = ?', userId)) {
        const inputs = parse(r.inputs_json, {}), factors = parse(r.factors_json, {});
        if (inputs.profile && inputs.profile.ocean) inputs.profile.ocean = 'withdrawn';
        if ('psychometric' in factors) factors.psychometric = null;
        if ('socioemotional' in factors) factors.socioemotional = null;
        h.run('UPDATE score_runs SET inputs_json = ?, factors_json = ? WHERE id = ?', JSON.stringify(inputs), JSON.stringify(factors), r.id);
      }
    });
  }
  app.get('/api/me/profile', need('student'), needConsent('profile'), (req, res) => {
    // Nothing is filled in for a new student: until they type their programme, year and target role there is no profile.
    if (!profileRow(req.user.id)) return res.json({ needsSetup: true });
    res.json(profilePayload(req.user.id));
  });
  app.put('/api/me/profile', need('student'), needConsent('profile'), (req, res) => {
    const b = req.body || {}; const cur = profileRow(req.user.id) || {};
    if (!cur.user_id && !(D.PROGRAMMES.find((x) => x.id === b.prog) && has(D.ROLES, b.role) && parseInt(b.year, 10) >= 1)) return fail(res, 400, 'Type your programme, your year and the role you aspire to, to begin.');
    const prog = D.PROGRAMMES.find((x) => x.id === b.prog) ? b.prog : cur.programme || 'ba-psy';
    const years = D.PROGRAMMES.find((x) => x.id === prog).years;
    const role = has(D.ROLES, b.role) ? b.role : has(D.ROLES, cur.target_role) ? cur.target_role : 'hr';
    const num = (v, lo, hi) => (v === '' || v === null || v === undefined || Number.isNaN(+v) ? null : D.clamp(+v, lo, hi));
    if (b.cgpa !== undefined && b.cgpa !== '' && b.cgpa !== null && !(Number(b.cgpa) >= 0 && Number(b.cgpa) <= 10)) return fail(res, 400, 'CGPA must be a number from 0 to 10.');
    if (b.class12 !== undefined && b.class12 !== '' && b.class12 !== null && !(Number(b.class12) >= 0 && Number(b.class12) <= 100)) return fail(res, 400, 'Class 12 marks must be a percentage from 0 to 100.');
    // A field left out of the request keeps its stored value; an empty value clears it.
    const keep = (field, col, hi) => (b[field] === undefined ? cur[col] ?? null : num(b[field], 0, hi));
    // CGPA and career clarity can be corrected but not cleared once given: a blank is left out of the score,
    // so clearing a low value would otherwise raise it.
    const sticky = (field, col, hi) => { const v = keep(field, col, hi); return v === null ? cur[col] ?? null : v; };
    const newCgpa = sticky('cgpa', 'cgpa', 10), newC12 = sticky('class12', 'class12', 100);
    // The student's own ratings. A blank stays blank; a new role starts with all four unrated.
    const sameRole = role === cur.target_role, prevSkills = [0, 1, 2, 3].map((i) => (sameRole ? parse(cur.skills_json, [])[i] ?? null : null));
    // Ratings sent with a role change belong to the old role's boxes, so they are ignored.
    const skills = sameRole && Array.isArray(b.skills) && b.skills.length === 4 ? b.skills.map((s, i) => { const v = num(s, 0, 100); return v === null ? prevSkills[i] : Math.round(v); }) : prevSkills.slice();
    // A skill verified by a college assessment keeps the assessed value; the student cannot overwrite it.
    for (const [i, v] of Object.entries(verifiedSkills(req.user.id, role))) if (v != null) skills[+i] = v;
    // Questionnaire answers (Mini-IPIP, 20 items, 1–5): keep what is stored unless new answers are sent; never store them without consent.
    // Answers are saved as they are given, so a student can stop and come back; the traits count only once all 20 are answered.
    let ocean = hasConsent(req.user.id, 'psychometric') ? parse(cur.ocean_json, null) : null;
    if (b.ipip === null) ocean = null;
    else if (Array.isArray(b.ipip) && b.ipip.length === D.IPIP.length && hasConsent(req.user.id, 'psychometric')) {
      const prev = ipipAnswers(cur.ocean_json);
      ocean = { answers: b.ipip.map((a, i) => { if (a === null || a === '') return a === null ? prev[i] : null; const v = Number(a); return Number.isInteger(v) && v >= 1 && v <= 5 ? v : prev[i]; }) };
    }
    // Transversal skills: the student's own ratings. A blank keeps what was there; an assessed skill is set by the mentor and shown instead.
    const prevTv = D.TRANSVERSAL.map((_, i) => parse(cur.transversal_json, [])[i] ?? null);
    const tv = Array.isArray(b.transversal) && b.transversal.length === D.TRANSVERSAL.length ? b.transversal.map((x, i) => { const v = num(x, 0, 100); return v === null ? prevTv[i] : Math.round(v); }) : prevTv;
    // Up to two more roles the student is considering, compared with the main one. Choosing one of them as the main role swaps the two.
    let others = parse(cur.other_roles_json, []).filter((k) => has(D.ROLES, k));
    if (Array.isArray(b.otherRoles)) others = b.otherRoles.filter((k) => has(D.ROLES, k));
    if (cur.target_role && role !== cur.target_role && others.includes(role)) others = others.map((k) => (k === role ? cur.target_role : k));
    others = [...new Set(others)].filter((k) => k !== role).slice(0, 2);
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
    h.run('UPDATE profiles SET goal = ?, interests = ?, cities = ?, own_skills_json = ?, transversal_json = ?, other_roles_json = ? WHERE user_id = ?', words('goal', 'goal', 200), words('interests', 'interests', 200), words('cities', 'cities', 120), JSON.stringify(own), JSON.stringify(tv), JSON.stringify(others), req.user.id);
    // A changed CGPA has to be confirmed again by the mentor before it counts.
    if (newCgpa !== (cur.cgpa ?? null)) h.run('UPDATE profiles SET cgpa_confirmed = 0 WHERE user_id = ?', req.user.id);
    // Class 12 marks: used only until a first CGPA exists, and confirmed again by the mentor when changed.
    if (newC12 !== (cur.class12 ?? null)) h.run('UPDATE profiles SET class12 = ?, class12_confirmed = 0 WHERE user_id = ?', newC12, req.user.id);
    // A new aspired role means a different plan: earlier accepted steps and mentor reviews no longer apply.
    if (cur.target_role && cur.target_role !== role) {
      h.run('DELETE FROM recommendation_states WHERE user_id = ?', req.user.id);
      audit(req.user.id, 'plan.reset_for_new_role', role);
    }
    audit(req.user.id, 'profile.updated');
    res.json(profilePayload(req.user.id));
  });
  app.post('/api/me/score', need('student'), needConsent('profile'), (req, res) => {
    const c = computeFor(req.user.id); if (!c) return fail(res, 404, 'Type your programme, year and aspired role on My score first. Nothing is filled in for you.');
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
    const mime = Object.keys(FILE_TYPES).find((t) => FILE_TYPES[t] === kind);
    h.run("UPDATE evidence SET file_name = ?, file_path = ?, file_type = ?, status = 'pending', ai_check_json = NULL WHERE id = ?", name, stored, mime, e.id);
    audit(req.user.id, 'evidence.file_uploaded', e.id);
    // Only for students who agreed: an AI first look at the file, shown to the mentor as a hint. It never verifies anything.
    if (hasConsent(req.user.id, 'ai_proof_check')) {
      Promise.resolve(proofChecker({ buffer: req.body, mime, studentName: req.user.name, title: e.title, typeLabel: D.EVIDENCE_TYPES[e.type] })).then((r) => {
        const clean = r && ai.cleanCheck({ name_matches: r.nameMatches ?? r.name_matches, title_matches: r.titleMatches ?? r.title_matches, issuer: r.issuer, date_on_document: r.date ?? r.date_on_document, summary: r.summary });
        if (clean && hasConsent(req.user.id, 'ai_proof_check')) h.run('UPDATE evidence SET ai_check_json = ? WHERE id = ? AND file_path = ?', JSON.stringify({ ...clean, at: new Date().toISOString() }), e.id, stored);
      }).catch(() => {});
    }
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
      const r = recsFor(req.user.id); if (!r) return fail(res, 404, 'Type your programme, year and aspired role on My score first. Nothing is filled in for you.');
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
      res.json({ score: r.c.result, projected: D.projectIndex(r.c.p, r.c.ev, accepted, r.ctx), context: { yearsLeft: r.ctx.yearsLeft, peers: r.ctx.peers ? { label: r.ctx.peers.label, n: r.ctx.peers.n } : null, employerPosts: r.ctx.demand.bySkill.reduce((a, b) => a + b, 0) }, role: r.c.p.role, programme: r.c.p.prog, year: r.c.p.year, path: D.pathNote(r.c.p), own: ownSteps(req.user.id), mine: inWords(r.c.row),
        items: r.list.map((x) => ({ id: x.id, factor: x.factor, slot: x.slot, effort: x.effort, gain: x.gain, always: x.always, title: x.title, what: x.what, why: x.why, aiWhy: x.aiWhy || null, assume: x.assume, learn: x.learn, because: x.because, crosses: x.crosses, personal: x.personal,
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
    const c = computeFor(req.user.id); if (!c) return fail(res, 404, 'Type your programme, year and aspired role on My score first. Nothing is filled in for you.');
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

  // One-page summary a student can print or save as PDF and share with an employer. Only confirmed or verified items are
  // listed as such; self-reported ones are marked. Personality results are private and never included.
  app.get('/api/me/report', need('student'), needConsent('profile'), (req, res) => {
    const c = computeFor(req.user.id); if (!c) return fail(res, 404, 'Type your programme, year and aspired role on My score first. Nothing is filled in for you.');
    const u = h.get('SELECT i.name AS college FROM users u LEFT JOIN institutions i ON i.id = u.institution_id WHERE u.id = ?', req.user.id) || {};
    const R = D.ROLES[c.p.role], status = (v, a, rated) => (a ? 'assessed' : rated ? 'self-rated' : 'not rated');
    audit(req.user.id, 'report.viewed');
    res.json({ name: req.user.name, college: u.college || null, programme: D.programme(c.p.prog).label, year: c.p.year, role: R.label, otherRoles: c.p.otherRoles.map((k) => D.ROLES[k].label),
      index: c.result.index, confirmedIndex: c.result.confirmedIndex, band: D.band(c.result.index), version: c.result.version, completeness: c.result.completeness,
      cgpa: c.p.cgpa, cgpaConfirmed: c.p.cgpaConfirmed, class12: c.p.cgpa == null ? c.p.class12 : null, class12Confirmed: c.p.class12Confirmed,
      factors: D.FACTORS.filter((F) => F.k !== 'socioemotional').map((F) => ({ label: F.label, w: F.w, value: c.result.factors[F.k] })),
      skills: R.skills.map((name, i) => ({ name, value: c.p.skillsRated[i] || c.p.skillsVerified[i] ? c.p.skills[i] : null, status: status(c.p.skills[i], c.p.skillsVerified[i], c.p.skillsRated[i]) })),
      transversal: D.TRANSVERSAL.map((name, i) => ({ name, value: c.p.transversal[i], status: status(c.p.transversal[i], c.p.transversalVerified[i], c.p.transversal[i] != null) })),
      evidence: c.ev.filter((e) => e.type !== 'assessment' && e.status === 'verified').map((e) => ({ type: D.EVIDENCE_TYPES[e.type], title: e.title, on: e.completed_on, by: e.verified_by })),
      waiting: c.ev.filter((e) => e.type !== 'assessment' && e.status === 'pending').length, generatedAt: new Date().toISOString() });
  });

  // ---------- Openings from public sources (admin) ----------
  app.get('/api/admin/openings', need('admin'), (req, res) => res.json(h.all('SELECT * FROM public_openings ORDER BY id DESC LIMIT 200')
    .map((o) => ({ ...o, roleLabel: (D.ROLES[o.role] || {}).label || o.role, kindLabel: D.SOURCE_KINDS[o.source_kind] || '', skills: parse(o.skills_json, []), skills_json: undefined }))));
  // Check one opening typed by the admin, or one line of an upload. Returns { error } or the row to save.
  // roleKey is the role already worked out from what was typed (a new role is only made once every line is right).
  function openingFrom(b, roleKey) {
    if (!roleKey) return { error: 'Type the role these openings are for.' };
    const kind = String(b.sourceKind || '');
    if (!has(D.SOURCE_KINDS, kind)) return { error: 'Say where it was found: company careers page, government notice, Employment News, recruitment agency, partner organisation or job portal.' };
    if (kind === 'agency' && b.clientAgreed !== true) return { error: 'An agency\u2019s opening is listed only when its client agreed. Confirm that it did.' };
    const title = L.clean(b.title, 120), org = L.clean(b.organisation, 120), source = L.clean(b.sourceName, 80) || D.SOURCE_KINDS[kind].split(',')[0], url = httpsUrl(String(b.sourceUrl || '').trim());
    if (!title) return { error: 'Type the job title as the source gives it.' };
    if (!org) return { error: 'Type the organisation that is hiring.' };
    if (!url) return { error: 'Paste the link to the source, starting with https://, so students can check it.' };
    const openings = b.openings === undefined || b.openings === null || b.openings === '' ? 1 : Number(b.openings);
    if (!Number.isInteger(openings) || openings < 1 || openings > 500) return { error: 'Openings must be a whole number from 1 to 500.' };
    let posted = null;
    if (b.postedOn) { if (!dayOk(b.postedOn) || new Date(b.postedOn + 'T00:00:00Z').getTime() > Date.now()) return { error: 'Enter the date it was posted, not in the future.' }; posted = b.postedOn; }
    const skills = []; for (const x of String(Array.isArray(b.skills) ? b.skills.join(',') : b.skills || '').split(/[,;\n]/)) { const t = L.clean(x, 40); if (t && skills.length < 8 && !skills.some((k) => L.norm(k) === L.norm(t))) skills.push(t); }
    return { row: [title, org, roleKey, L.clean(b.city, 60) || null, JSON.stringify(skills), openings, source, url, posted, kind] };
  }
  const saveOpening = (row, userId) => h.run('INSERT INTO public_openings (title, organisation, role, city, skills_json, openings, source_name, source_url, posted_on, source_kind, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...row, userId);
  app.post('/api/admin/openings', need('admin'), (req, res) => {
    const b = req.body || {};
    const o = openingFrom(b, has(D.ROLES, b.role) ? b.role : null);
    if (o.error) return fail(res, 400, o.error);
    const r = saveOpening(o.row, req.user.id);
    audit(req.user.id, 'admin.opening_added', r.lastInsertRowid);
    res.status(201).json({ ok: true, id: Number(r.lastInsertRowid) });
  });
  // Many openings at once, one per line, with the role typed as text. Nothing is saved if any line has a mistake.
  app.post('/api/admin/openings/import', need('admin'), (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : [];
    if (!rows.length) return fail(res, 400, 'Add at least one line.');
    const errors = [], ok = [];
    rows.forEach((b, i) => {
      if (!b || typeof b !== 'object') return errors.push(`Line ${i + 1}: could not be read.`);
      const made = L.makeRole(b.role);
      if (!made) return errors.push(`Line ${i + 1}: type the role, for example Data Analyst.`);
      const o = openingFrom(b, sameRole(made) || 'new');
      if (o.error) return errors.push(`Line ${i + 1}: ${o.error}`);
      ok.push({ o, roleText: b.role, isNew: !sameRole(made) });
    });
    if (errors.length) return fail(res, 400, errors.slice(0, 20).join(' '));
    for (const x of ok.filter((y) => y.isNew)) x.o.row[2] = resolveRole(x.roleText, req.user).key;
    h.tx(() => { for (const x of ok) saveOpening(x.o.row, req.user.id); });
    audit(req.user.id, 'admin.openings_imported', ok.length);
    res.status(201).json({ added: ok.length });
  });
  app.delete('/api/admin/openings/:id', need('admin'), (req, res) => {
    const r = h.run('DELETE FROM public_openings WHERE id = ?', +req.params.id); if (!r.changes) return fail(res, 404, 'Not found.');
    audit(req.user.id, 'admin.opening_removed', +req.params.id); res.json({ ok: true });
  });

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
  app.get('/api/college/activity', need('college_admin', 'mentor'), atCollege, (req, res) => {
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
        fit: D.pathNote(c.p).label, inWords: { ...inWords(c.row), steps: ownSteps(r.id) }, cgpa: c.p.cgpa, cgpaConfirmed: c.p.cgpaConfirmed, class12: c.p.class12, class12Confirmed: c.p.class12Confirmed, skills: c.p.skills, skillsRated: c.p.skillsRated, skillsVerified: c.p.skillsVerified, transversal: c.p.transversal, transversalVerified: c.p.transversalVerified, otherRoles: c.p.otherRoles.map((k) => D.ROLES[k].label), confirmedIndex: c.result.confirmedIndex };
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
      for (const x of r.list) recItems.push({ studentId: s.id, studentName: s.name, ruleId: x.id, title: x.title, why: x.why, gain: x.gain, because: x.because, personal: x.personal,
        student: x.state?.student_status || null, mentor: x.state?.mentor_status || null, note: x.state?.mentor_note || null });
      const withAi = hasConsent(s.id, 'ai_proof_check');
      for (const e of r.c.ev.filter((e) => e.status !== 'verified')) evItems.push({ studentId: s.id, studentName: s.name, ...e, typeLabel: D.EVIDENCE_TYPES[e.type], aiCheck: withAi ? aiCheckOf(e.id) : null });
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
    // Marks are checked against college records, so only a mentor at the student's own college can confirm them.
    if ((what === 'cgpa' || what === 'class12') && (!req.user.institution_id || req.user.institution_id !== (h.get('SELECT institution_id FROM users WHERE id = ?', sid) || {}).institution_id))
      return fail(res, 403, 'Only a mentor at the student\u2019s college can confirm marks against college records.');
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
    if (what === 'class12') {
      // Confirming Class 12 marks for a student with no CGPA yet: the mentor enters the percentage from the marks card.
      if (req.body?.value === '' || req.body?.value == null || !Number.isFinite(value) || value < 0 || value > 100) return fail(res, 400, 'Enter the Class 12 percentage from the marks card, from 0 to 100.');
      const pct = Math.round(value * 10) / 10;
      h.tx(() => {
        h.run("DELETE FROM evidence WHERE user_id = ? AND type = 'assessment' AND skill_role = 'class12'", sid);
        h.run("INSERT INTO evidence (user_id, type, title, completed_on, status, verified_by, verified_at, skill_index, skill_role, skill_value) VALUES (?, 'assessment', ?, date('now'), 'verified', ?, datetime('now'), NULL, 'class12', ?)", sid, `Class 12 marks confirmed: ${pct}%`, req.user.name, Math.round(pct));
        h.run('UPDATE profiles SET class12 = ?, class12_confirmed = 1 WHERE user_id = ?', pct, sid);
      });
      audit(req.user.id, 'mentor.class12_confirmed', sid);
      return res.status(201).json({ ok: true, label: 'Class 12 marks', score: pct, class12: true });
    }
    // A role skill is "0"–"3"; a transversal skill is "t0"–"t4" (communication, leadership, creativity, problem solving, teamwork).
    // "communication" is accepted as the first transversal skill, as in earlier versions.
    const tm = /^t([0-4])$/.exec(String(what)), tIdx = what === 'communication' ? 0 : tm ? +tm[1] : null, idx = tIdx === null ? Number(what) : null;
    if (tIdx === null && !(Number.isInteger(idx) && idx >= 0 && idx <= 3)) return fail(res, 400, 'Choose what was assessed.');
    if (req.body?.value === '' || req.body?.value == null || !Number.isFinite(value) || value < 0 || value > 100) return fail(res, 400, 'Enter a score from 0 to 100.');
    const score = Math.round(value), role = tIdx !== null ? 'transversal' : row.target_role;
    const label = tIdx !== null ? D.TRANSVERSAL[tIdx] : D.ROLES[row.target_role].skills[idx];
    h.tx(() => {
      if (tIdx !== null) {
        h.run("DELETE FROM evidence WHERE user_id = ? AND type = 'assessment' AND skill_role = 'transversal' AND skill_index = ?", sid, tIdx);
        if (tIdx === 0) h.run("DELETE FROM evidence WHERE user_id = ? AND type = 'assessment' AND skill_role = 'communication'", sid);
      } else h.run("DELETE FROM evidence WHERE user_id = ? AND type = 'assessment' AND skill_role = ? AND skill_index = ?", sid, role, idx);
      h.run("INSERT INTO evidence (user_id, type, title, completed_on, status, verified_by, verified_at, skill_index, skill_role, skill_value) VALUES (?, 'assessment', ?, date('now'), 'verified', ?, datetime('now'), ?, ?, ?)",
        sid, `${label} assessment: ${score}/100`, req.user.name, tIdx !== null ? tIdx : idx, role, score);
      if (tIdx === null) { const sk = parse(row.skills_json, [null, null, null, null]); sk[idx] = score; h.run('UPDATE profiles SET skills_json = ? WHERE user_id = ?', JSON.stringify(sk), sid); }
    });
    audit(req.user.id, 'mentor.assessment_recorded', sid + ':' + (tIdx !== null ? 't' + tIdx : idx));
    res.status(201).json({ ok: true, label, score });
  });

  // ---------- College (mentor or college admin; own institution, aggregates only) ----------
  app.get('/api/college/cohort', need('mentor', 'college_admin'), atCollege, (req, res) => {
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
    const posts = postsFor(role), names = D.ROLES[role].skills.map(L.norm);
    const skills = {}; for (const p of posts) for (const k of p.skills) if (names.includes(L.norm(k))) { const n = D.ROLES[role].skills[names.indexOf(L.norm(k))]; skills[n] = (skills[n] || 0) + p.openings; }
    // For a student: which of these openings are in the cities they typed, and which extra skills employers typed that they have too.
    let personal = null;
    if (req.user.role === 'student') {
      const row = profileRow(req.user.id) || {}, cities = cityList(row), mine = parse(row.own_skills_json, []).map((x) => L.norm(x.name));
      const asked = {}; for (const p of posts) for (const k of p.skills) if (!names.includes(L.norm(k))) asked[k] = (asked[k] || 0) + p.openings;
      const inCity = posts.filter((p) => p.city && cities.some((c) => L.norm(p.city).includes(c)));
      personal = { cities: row.cities || '', openingsInMyCities: cities.length ? inCity.reduce((t, p) => t + p.openings, 0) : null,
        alsoAsked: Object.entries(asked).sort((a, b) => b[1] - a[1]).map(([name, openings]) => ({ name, openings, have: mine.includes(L.norm(name)) })) };
    }
    res.json({ role, personal, openings: posts.reduce((t, p) => t + p.openings, 0), employers: new Set(posts.map((p) => p.employer)).size,
      skills: Object.entries(skills).sort((a, b) => b[1] - a[1]).map(([name, openings]) => ({ name, openings })),
      fromSources: posts.filter((p) => p.source).length,
      latest: posts.slice(0, 6).map((p) => ({ employer: p.employer, title: p.title || null, city: p.city, openings: p.openings, postedAt: p.postedAt, source: p.source, sourceKind: p.sourceKind || null, url: p.url })), asOf: new Date().toISOString() });
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
        factors: Object.fromEntries(Object.entries(parse(r.factors_json, {})).map(([k, v]) => [k === 'cgpa' ? 'academic' : k, typeof v === 'number' ? (k === 'academic' || k === 'cgpa' ? Math.min(80, Math.floor(v / 20) * 20) : Math.round(v / 5) * 5) : v])) }));
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
  app.get('/api/admin/signups', need('admin'), (req, res) => res.json(h.all("SELECT s.email, s.name, s.role, COALESCE(i.name, s.org_name) AS org, s.extra_json, s.created_at FROM signups s LEFT JOIN institutions i ON i.id = s.institution_id WHERE s.status = 'waiting' ORDER BY s.created_at")
    .map(({ extra_json, ...r }) => { const v = parse(extra_json, {}).volunteer; return v ? { ...r, volunteer: { ...v, sectorLabel: D.SECTORS[v.sector] } } : r; })));
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
    const v = parse(row.extra_json, {}).volunteer;
    const user = auth.createFromSignup(row, row.institution_id, employerId);
    if (v && user.role === 'mentor') saveVolunteer(user.id, v);
    // A newly approved mentor takes on students at the college who have nobody yet. A volunteer waits to be asked.
    if (user.role === 'mentor' && user.institution_id) shareOut(user.institution_id);
    audit(req.user.id, 'admin.signup_approved', user.id);
    mailNotice(user.email, 'Your GRM account is approved', `Hello ${user.name},\n\nYour GRM account has been approved. You can now sign in with your email and the password you chose.`);
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
    // Students added without a named mentor get one; new mentors take on students who have nobody yet.
    for (const r of clean) if (r.role === 'student') giveMentor(r.id);
    for (const inst of new Set(clean.filter((r) => r.role === 'mentor').map((r) => h.get('SELECT institution_id FROM users WHERE id = ?', r.id).institution_id))) shareOut(inst);
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
    h.tx(() => { h.run('DELETE FROM mentor_links WHERE student_id = ? AND mentor_id NOT IN (SELECT user_id FROM volunteers)', st.id); if (m) h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', m.id, st.id); });
    audit(req.user.id, 'admin.mentor_' + (m ? 'set' : 'cleared'), st.id);
    res.json({ mentor: m ? email : null });
  });

  // Course catalogue and the course sites used for live searches.
  app.get('/api/admin/courses', need('admin'), (req, res) => res.json({ courses: h.all('SELECT * FROM courses ORDER BY id DESC'), sources: h.all('SELECT * FROM course_sources ORDER BY id') }));
  app.post('/api/admin/courses', need('admin'), (req, res) => {
    const b = req.body || {}, title = String(b.title || '').trim().slice(0, 200), provider = String(b.provider || '').trim().slice(0, 80), url = httpsUrl(b.url);
    // A course teaches one skill of a role (0–3) or one transversal skill (0–4). "communication" is the first transversal skill, as before.
    const isT = b.role === 'transversal' || b.role === 'communication', idx = b.role === 'communication' ? 0 : Number(b.skillIndex);
    if (!title || !provider) return fail(res, 400, 'Give the course title and who provides it.');
    if (!url) return fail(res, 400, 'Give the full course link, starting with https://');
    if (isT ? !(Number.isInteger(idx) && idx >= 0 && idx < D.TRANSVERSAL.length) : (!has(D.ROLES, b.role) || !(Number.isInteger(idx) && idx >= 0 && idx <= 3))) return fail(res, 400, 'Choose the role and skill this course teaches.');
    const weeks = b.weeks === '' || b.weeks == null ? null : Math.round(Number(b.weeks));
    if (weeks !== null && !(weeks >= 1 && weeks <= 104)) return fail(res, 400, 'Length in weeks must be from 1 to 104.');
    const r = h.run('INSERT INTO courses (title, provider, url, role, skill_index, weeks, free) VALUES (?, ?, ?, ?, ?, ?, ?)', title, provider, url, isT ? 'transversal' : b.role, idx, weeks, b.free === false ? 0 : 1);
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
