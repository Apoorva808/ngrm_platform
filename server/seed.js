// Sample data for local development and demos. Every person, college and employer here is fictional.
const fs = require('node:fs');
const path = require('node:path');
const { open, helpers } = require('./db');
const D = require('./domain');
const { hashPassword } = require('./auth');

function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const NAMES = ['Rahul Menon', 'Priya Nair', 'Mohammed Irfan', 'Sneha Kulkarni', 'Arjun Reddy', 'Divya Shetty', 'Karthik Iyer', 'Fatima Sheikh', 'Rohan Gowda', 'Meera Pillai', 'Aditya Joshi', 'Kavya Hegde', 'Siddharth Das', 'Neha Bhat', 'Vikram Singh', 'Lakshmi Murthy', 'Imran Khan', 'Pooja Patil', 'Nikhil Rao', 'Shreya Naik', 'Tanvi Deshpande', 'Harsha Kumar', 'Zoya Ahmed'];
const FIRST = ['Aarav', 'Diya', 'Kiran', 'Nisha', 'Varun', 'Asha', 'Rohit', 'Sana', 'Manoj', 'Ritu', 'Gautam', 'Bhavya', 'Yash', 'Anjali', 'Farhan', 'Keerthi', 'Suresh', 'Megha', 'Pranav', 'Ishita'];
const LAST = ['Shetty', 'Rao', 'Gowda', 'Naik', 'Kulkarni', 'Hegde', 'Iyer', 'Patil', 'Bhat', 'Reddy', 'Khan', 'Murthy', 'Joshi', 'Menon', 'Das'];

// What every database needs, sample data or not: the rule library, and the first admin if ADMIN_EMAIL is set.
function bootstrap(db, env = process.env) {
  const h = helpers(db);
  for (const r of D.DEFAULT_RULE_SETTINGS) h.run('INSERT OR IGNORE INTO rules (id, factor, slot, effort, threshold, active) VALUES (?, ?, ?, ?, ?, 1)', r.id, r.factor, r.slot, r.effort, r.threshold);
  // Course sites students are sent to for a live search. An admin can change these on the Admin page.
  if (!h.get('SELECT 1 FROM course_sources')) for (const [name, url] of [['SWAYAM', 'https://swayam.gov.in/explorer?searchText={q}'], ['Class Central', 'https://www.classcentral.com/search?q={q}'], ['Coursera', 'https://www.coursera.org/search?query={q}']])
    h.run('INSERT INTO course_sources (name, url_template) VALUES (?, ?)', name, url);
  // Starter catalogue of checked courses, loaded once. If an admin has curated the list (even down to empty), it is left alone.
  if (!h.get('SELECT 1 FROM courses') && !h.get("SELECT 1 FROM audit_log WHERE action IN ('admin.course_added', 'admin.course_removed')"))
    for (const [role, idx, title, provider, url, free] of require('./courses')) h.run('INSERT INTO courses (title, provider, url, role, skill_index, free) VALUES (?, ?, ?, ?, ?, ?)', title, provider, url, role, idx, free);
  const email = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) return null;
  let u = h.get('SELECT id FROM users WHERE email = ?', email), created = false;
  if (!u) { u = { id: h.run("INSERT INTO users (email, name, role, is_sample) VALUES (?, ?, 'admin', 0)", email, String(env.ADMIN_NAME || 'NGRM admin').trim()).lastInsertRowid }; created = true; }
  // The first admin signs in with ADMIN_PASSWORD and must then choose their own. Once they have a password, ADMIN_PASSWORD is ignored.
  if (env.ADMIN_PASSWORD && !h.get('SELECT 1 FROM passwords WHERE user_id = ?', u.id)) h.run('INSERT INTO passwords (user_id, hash, must_change) VALUES (?, ?, 1)', u.id, hashPassword(String(env.ADMIN_PASSWORD)));
  return created ? email : null;
}

function seed(db) {
  const h = helpers(db);
  if (h.get('SELECT COUNT(*) AS n FROM users').n > 0) return false;
  const R = rng(2026);
  h.tx(() => {
    for (const r of D.DEFAULT_RULE_SETTINGS) h.run('INSERT OR IGNORE INTO rules (id, factor, slot, effort, threshold, active) VALUES (?, ?, ?, ?, ?, 1)', r.id, r.factor, r.slot, r.effort, r.threshold);
    const insts = [['Sample College', 'Bengaluru'], ['Sample College', 'Mysuru'], ['Sample College', 'Hubballi']]
      .map(([n, c]) => Number(h.run('INSERT INTO institutions (name, city) VALUES (?, ?)', `${n}, ${c}`, c).lastInsertRowid));
    const emps = [['Sample Employer A · HR services', 'Bengaluru'], ['Sample Employer B · fintech', 'Bengaluru'], ['Sample Employer C · hospital network', 'Mysuru']]
      .map(([n, c]) => Number(h.run('INSERT INTO employers (name, city) VALUES (?, ?)', n, c).lastInsertRowid));
    const user = (email, name, role, inst, emp) => Number(h.run('INSERT INTO users (email, name, role, institution_id, employer_id) VALUES (?, ?, ?, ?, ?)', email, name, role, inst ?? null, emp ?? null).lastInsertRowid);
    const consent = (uid, purpose) => h.run('INSERT INTO consents (user_id, purpose, granted, is_adult) VALUES (?, ?, 1, 1)', uid, purpose);
    const profile = (uid, p, optIn) => h.run('INSERT INTO profiles (user_id, programme, year, cgpa, cgpa_confirmed, target_role, skills_json, ocean_json, comm, clarity, opt_in_intros) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      uid, p.prog, p.year, p.cgpa, p.cgpaConfirmed ? 1 : 0, p.role, JSON.stringify(p.skills), p.ocean ? JSON.stringify(p.ocean) : null, p.comm ?? null, p.clarity ?? null, optIn ? 1 : 0);
    const evidence = (uid, type, title, status, by, extra = {}) => h.run('INSERT INTO evidence (user_id, type, title, completed_on, status, verified_by, verified_at, skill_index, skill_role, skill_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      uid, type, title, extra.date || null, status, by || null, status === 'verified' ? '2026-10-01 10:00:00' : null, extra.skill ?? null, extra.role ?? null, extra.value ?? null);

    // Demo accounts (sign in with one click when DEMO_MODE=true)
    const ananya = user('ananya@demo.ngrm.in', 'Ananya Rao', 'student', insts[0]);
    const kavya = user('kavya@demo.ngrm.in', 'Dr. Kavya S.', 'mentor', insts[0]);
    user('placement@demo.ngrm.in', 'Placement Cell, Sample College Bengaluru', 'college_admin', insts[0]);
    user('recruiter@demo.ngrm.in', 'Recruiter, Sample Employer A', 'employer', null, emps[0]);
    user('research@demo.ngrm.in', 'Study researcher', 'researcher');
    user('admin@demo.ngrm.in', 'NGRM admin', 'admin');

    consent(ananya, 'profile'); consent(ananya, 'psychometric');
    profile(ananya, { prog: 'ba-psy', year: 2, cgpa: 7.6, cgpaConfirmed: true, role: 'hr', skills: [55, 72, 60, 45], ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, comm: null, clarity: 55 }, false);
    evidence(ananya, 'course', 'NPTEL course in research methods', 'verified', 'Course certificate', { date: '2026-05-20' });
    evidence(ananya, 'project', 'Survey study on exam stress among first-year students', 'verified', 'Dr. Kavya S.', { date: '2026-09-15' });
    evidence(ananya, 'assessment', 'Research methods skill check', 'verified', 'Department of Psychology', { date: '2026-10-02', skill: 1, role: 'hr', value: 72 });
    h.run("INSERT INTO recommendation_states (user_id, rule_id, mentor_status, mentor_note, mentor_id, mentor_at) VALUES (?, 'project', 'approved', ?, ?, datetime('now'))", ananya, 'Good fit. Tie it to the NGO survey we discussed for next semester.', kavya);
    h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', kavya, ananya);

    // Students: a mentored cohort at the Bengaluru college, plus a pool across all three colleges.
    const roleKeys = Object.keys(D.ROLES);
    const plan = [['ba-psy', ['hr', 'wellbeing', 'ux']], ['bcom', ['marketing', 'founder', 'data']], ['bsc-cs', ['dev', 'data', 'ux']]];
    let n = 0;
    const makeStudent = (name, inst, prog, role) => {
      n++;
      const uid = user(`student${n}@sample.ngrm.in`, name, 'student', inst);
      const optIn = R() < 0.22;
      // How far along this sample student is, so the cohort spreads across all three bands.
      const drive = R();
      consent(uid, 'profile'); consent(uid, 'psychometric'); if (optIn) consent(uid, 'introductions');
      // Most sample students have had their CGPA confirmed and most of their skills assessed; the rest are still waiting.
      const skillVals = D.ROLES[role].skills.map(() => Math.round(30 + drive * 25 + R() * 40));
      const C = rng(n * 7919), cgpaConfirmed = C() < 0.85, skillsVerified = skillVals.map(() => C() < 0.85);
      profile(uid, { prog, year: R() < 0.5 ? 1 : 2, cgpa: Math.round((5.6 + R() * 3.6) * 10) / 10, cgpaConfirmed, role, skills: skillVals,
        ocean: { o: Math.round(35 + R() * 50), c: Math.round(35 + R() * 50), e: Math.round(30 + R() * 55), a: Math.round(40 + R() * 45), n: Math.round(25 + R() * 50) },
        comm: R() < 0.4 ? Math.round(50 + R() * 40) : null, clarity: Math.round(35 + R() * 60) }, optIn);
      skillVals.forEach((v, i) => { if (skillsVerified[i]) evidence(uid, 'assessment', `${D.ROLES[role].skills[i]} assessment: ${v}/100`, 'verified', 'College assessment', { skill: i, role, value: v }); });
      const assessed = h.get('SELECT comm FROM profiles WHERE user_id = ?', uid).comm;
      if (assessed != null) evidence(uid, 'assessment', `Communication assessment: ${assessed}/100`, 'verified', 'College assessment', { role: 'communication', value: assessed });
      for (let i = 0; i < Math.floor(R() * 3); i++) evidence(uid, 'course', 'NPTEL course', 'verified', 'Course certificate');
      if (R() < 0.3) evidence(uid, 'certificate', 'Skill certificate', 'verified', 'Issuer');
      for (let i = 0; i < Math.min(3, Math.floor(R() * 2 + drive * 2.4)); i++) evidence(uid, 'project', 'Course project', R() < 0.8 ? 'verified' : 'pending', 'Faculty mentor');
      if (R() < 0.1 + 0.7 * drive) evidence(uid, 'internship', 'Summer internship', 'verified', 'Placement cell');
      if (drive > 0.6 && R() < 0.5) evidence(uid, 'internship', 'Winter internship', 'verified', 'Placement cell');
      if (R() < 0.2 + 0.6 * drive) evidence(uid, 'role', 'NSS volunteer', 'verified', 'NSS programme officer');
      if (drive > 0.7 && R() < 0.4) evidence(uid, 'role', 'Club coordinator', 'verified', 'Faculty in charge');
      if (R() < 0.3) {
        consent(uid, 'study');
        const p = JSON.parse(JSON.stringify(h.get('SELECT * FROM profiles WHERE user_id = ?', uid)));
        const ev = h.all('SELECT type, status FROM evidence WHERE user_id = ?', uid);
        const prof = { prog: p.programme, year: p.year, cgpa: p.cgpa, cgpaConfirmed, role: p.target_role, skills: JSON.parse(p.skills_json), skillsVerified, ocean: JSON.parse(p.ocean_json), comm: p.comm, clarity: p.clarity };
        const s = D.score(prof, ev);
        const run = h.run('INSERT INTO score_runs (user_id, formula_version, inputs_json, factors_json, index_value) VALUES (?, ?, ?, ?, ?)', uid, s.version, JSON.stringify({ profile: prof, counts: s.counts }), JSON.stringify(s.factors), s.index);
        h.run('INSERT INTO baselines (user_id, score_run_id) VALUES (?, ?)', uid, run.lastInsertRowid);
      }
      return uid;
    };
    NAMES.forEach((name, i) => {
      const g = plan[(i + 1) % 3];
      const uid = makeStudent(name, insts[0], g[0], g[1][Math.floor(R() * 3)]);
      if (i < 11) h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', kavya, uid);
    });
    insts.forEach((inst, c) => {
      // Sample mentors, so that sample students are mentored like real ones would be.
      const sampleMentors = [1, 2, 3, 4].map((k) => user(`mentor${k}.c${c + 1}@sample.ngrm.in`, `Sample Mentor ${k}`, 'mentor', inst));
      for (let i = 0; i < 120; i++) {
        const g = plan[Math.floor(R() * 3)];
        makeStudent(`${FIRST[Math.floor(R() * FIRST.length)]} ${LAST[Math.floor(R() * LAST.length)]}`, inst, g[0], roleKeys[Math.floor(R() * roleKeys.length)]);
      }
      // Every sample student at this college who has no mentor yet is shared among the sample mentors in turn.
      h.all("SELECT u.id FROM users u WHERE u.role = 'student' AND u.institution_id = ? AND NOT EXISTS (SELECT 1 FROM mentor_links l WHERE l.student_id = u.id) ORDER BY u.id", inst)
        .forEach((st, i) => h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, ?)', sampleMentors[i % sampleMentors.length], st.id));
    });

    h.run('INSERT INTO demand_posts (employer_id, role, skills_json, openings, city) VALUES (?, ?, ?, ?, ?)', emps[0], 'hr', JSON.stringify(['Excel and data analysis', 'Research methods']), 4, 'Bengaluru');
    h.run('INSERT INTO demand_posts (employer_id, role, skills_json, openings, city) VALUES (?, ?, ?, ?, ?)', emps[1], 'data', JSON.stringify(['SQL', 'Statistics']), 6, 'Bengaluru');
    h.run('INSERT INTO demand_posts (employer_id, role, skills_json, openings, city) VALUES (?, ?, ?, ?, ?)', emps[2], 'wellbeing', JSON.stringify(['Active listening', 'Ethics and confidentiality']), 3, 'Mysuru');
    // One earlier introduction request, with replies from some students who opted in.
    const intro = h.run("INSERT INTO intro_requests (employer_id, role, created_at) VALUES (?, 'data', datetime('now', '-5 days'))", emps[1]).lastInsertRowid;
    for (const u of h.all("SELECT p.user_id FROM profiles p WHERE p.target_role = 'data' AND p.opt_in_intros = 1")) if (R() < 0.6) h.run('INSERT INTO intro_replies (request_id, user_id) VALUES (?, ?)', intro, u.user_id);
  });
  return true;
}

module.exports = { seed, bootstrap };

if (require.main === module) {
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ngrm.sqlite');
  if (process.argv.includes('--reset')) for (const f of [file, file + '-wal', file + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  const db = open(file);
  console.log(seed(db) ? `Seeded sample data into ${file}` : 'Database already has data; run with --reset to start over.');
}
