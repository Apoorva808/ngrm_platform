const test = require('node:test');
const assert = require('node:assert/strict');
const { open, helpers } = require('../server/db');
const { seed } = require('../server/seed');
const { createApp } = require('../server/app');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ngrm-up-'));

let server, base, h, db;
const D = require('../server/domain');
test.before(async () => {
  process.env.DEV_SHOW_OTP = 'true';
process.env.COURSE_FEED = 'off'; // the live feed is tested below with a stand-in, never the real network
  db = open(':memory:'); seed(db); h = helpers(db);
  // Most tests run with emailed codes switched on; the password-only default has its own tests at the end.
  server = createApp(db, { demoMode: true, emailCodes: true, sendCode: () => {}, uploadDir: uploads }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = 'http://localhost:' + server.address().port;
});
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
}
async function as(email) { const c = client(); const r = await c('POST', '/api/auth/demo', { email }); assert.equal(r.status, 200); return c; }

test('signed-out requests to student data are refused', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/me/profile')).status, 401);
  assert.deepEqual((await c('GET', '/api/me')).body, { user: null });
});

test('one-time code sign-in works and locks after five wrong attempts', async () => {
  const c = client();
  const req = await c('POST', '/api/auth/request-code', { email: 'ananya@demo.ngrm.in' });
  assert.match(req.body.devCode, /^\d{6}$/);
  assert.equal((await c('POST', '/api/auth/verify', { email: 'ananya@demo.ngrm.in', code: '000000' })).status, 400);
  const ok = await c('POST', '/api/auth/verify', { email: 'ananya@demo.ngrm.in', code: req.body.devCode });
  assert.equal(ok.status, 200);
  assert.equal((await c('GET', '/api/me')).body.user.role, 'student');
  const c2 = client(); await c2('POST', '/api/auth/request-code', { email: 'kavya@demo.ngrm.in' });
  for (let i = 0; i < 5; i++) await c2('POST', '/api/auth/verify', { email: 'kavya@demo.ngrm.in', code: '111111' });
  const locked = await c2('POST', '/api/auth/verify', { email: 'kavya@demo.ngrm.in', code: '111111' });
  assert.match(locked.body.error, /Too many/);
});

test('codes cannot be requested over and over (stops guessing)', async () => {
  const c = client(), email = 'placement@demo.ngrm.in';
  assert.equal((await c('POST', '/api/auth/request-code', { email })).status, 200);
  const again = await c('POST', '/api/auth/request-code', { email });
  assert.equal(again.status, 429);
  // The limit applies to unknown emails too, so it reveals nothing about who has an account.
  await c('POST', '/api/auth/request-code', { email: 'ghost@example.com' });
  assert.equal((await c('POST', '/api/auth/request-code', { email: 'ghost@example.com' })).status, 429);
  h.run('UPDATE otp_requests SET at = at - 31000 WHERE email = ?', email);
  assert.equal((await c('POST', '/api/auth/request-code', { email })).status, 200);
});

test('unknown emails get the same response as known ones', async () => {
  process.env.DEV_SHOW_OTP = 'false';
  try {
    const known = await client()('POST', '/api/auth/request-code', { email: 'research@demo.ngrm.in' });
    const unknown = await client()('POST', '/api/auth/request-code', { email: 'nobody@example.com' });
    assert.deepEqual(unknown.body, { sent: true });
    assert.deepEqual(known.body, unknown.body);
  } finally { process.env.DEV_SHOW_OTP = 'true'; }
});

test('a malformed cookie does not break the site', async () => {
  const r = await fetch(base + '/api/me', { headers: { cookie: 'ngrm_session=%E0%A4%A' } });
  assert.equal(r.status, 200);
});

test('roles cannot reach each other’s endpoints', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const employer = await as('recruiter@demo.ngrm.in');
  assert.equal((await student('GET', '/api/mentor/queue')).status, 403);
  assert.equal((await student('GET', '/api/employer/supply?role=hr')).status, 403);
  assert.equal((await employer('GET', '/api/me/profile')).status, 403);
  assert.equal((await employer('GET', '/api/college/cohort')).status, 403);
  assert.equal((await employer('GET', '/api/research/export')).status, 403);
});

test('employers only ever receive counts, and groups under 5 are hidden', async () => {
  const employer = await as('recruiter@demo.ngrm.in');
  for (const role of ['hr', 'data', 'dev', 'founder']) {
    const r = await employer('GET', '/api/employer/supply?role=' + role);
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body);
    assert.ok(!/email|name"|index|score|ocean|"id"/i.test(text.replace(/"college":"[^"]*"/g, '').replace(/"name":"[^"]*","sharePct"/g, '')), 'no personal fields');
    const nums = [...r.body.byCollege, r.body.total].flatMap((c) => [c.foundation, c.intermediate, c.strong, c.optedIn]);
    for (const n of nums) assert.ok(n === null || (n >= 5 && n % 5 === 0), 'every visible count is 5 or more, rounded to 5');
  }
});

test('a student’s decline cannot be overridden by their mentor', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const mentor = await as('kavya@demo.ngrm.in');
  assert.equal((await student('PATCH', '/api/me/recommendations/communication', { action: 'decline' })).status, 200);
  const r = await mentor('PATCH', '/api/mentor/reviews/1/communication', { action: 'approve' });
  assert.equal(r.status, 409);
  await student('PATCH', '/api/me/recommendations/communication', { action: 'undo' });
});

test('mentors can only act on their own mentees', async () => {
  const mentor = await as('kavya@demo.ngrm.in');
  const other = h.get("SELECT u.id FROM users u WHERE u.role = 'student' AND u.id NOT IN (SELECT l.student_id FROM mentor_links l JOIN users m ON m.id = l.mentor_id WHERE m.email = 'kavya@demo.ngrm.in') LIMIT 1").id;
  assert.equal((await mentor('PATCH', `/api/mentor/reviews/${other}/project`, { action: 'approve' })).status, 404);
  const ev = h.get('SELECT id FROM evidence WHERE user_id = ? LIMIT 1', other);
  if (ev) assert.equal((await mentor('POST', `/api/mentor/evidence/${ev.id}`, { action: 'verify' })).status, 404);
});

test('students cannot touch another student’s evidence', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const foreign = h.get('SELECT id FROM evidence WHERE user_id != 1 LIMIT 1').id;
  assert.equal((await student('DELETE', '/api/me/evidence/' + foreign)).status, 404);
});

test('consent is required before a profile is stored, and under-18s need a guardian', async () => {
  const id = Number(h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('new@demo.ngrm.in', 'New Student', 'student', 1)").lastInsertRowid);
  const c = await as('new@demo.ngrm.in');
  const blocked = await c('GET', '/api/me/profile');
  assert.equal(blocked.status, 403); assert.match(blocked.body.error, /consent_required:profile/);
  assert.equal((await c('POST', '/api/me/consents', { purposes: { profile: true }, isAdult: false })).status, 400);
  assert.equal((await c('POST', '/api/me/consents', { purposes: { profile: true }, isAdult: false, guardianName: 'Parent Name' })).status, 200);
  assert.equal((await c('GET', '/api/me/profile')).status, 200);
  // Questionnaire answers are ignored without psychometric consent
  const put = await c('PUT', '/api/me/profile', { prog: 'bcom', year: 1, cgpa: 7, role: 'marketing', skills: [50, 50, 50, 50], ocean: { o: 90, c: 90, e: 90, a: 90, n: 10 } });
  assert.equal(put.body.profile.ocean, null);
  assert.equal(put.body.score.factors.psychometric, null, 'not yet rated, never a default');
  assert.ok(id > 0);
});

test('withdrawing introduction consent removes the student from opted-in counts', async () => {
  const student = await as('ananya@demo.ngrm.in');
  await student('PATCH', '/api/me/intro-opt-in', { optIn: true });
  assert.equal(h.get('SELECT opt_in_intros FROM profiles WHERE user_id = 1').opt_in_intros, 1);
  await student('POST', '/api/me/consents', { purposes: { introductions: false }, isAdult: true });
  assert.equal(h.get('SELECT opt_in_intros FROM profiles WHERE user_id = 1').opt_in_intros, 0);
});

test('every recorded score keeps its formula version and inputs', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const r = await student('POST', '/api/me/score');
  const row = h.get('SELECT * FROM score_runs WHERE id = ?', r.body.id);
  assert.equal(row.formula_version, 'v0.3');
  assert.ok(JSON.parse(row.inputs_json).profile);
  assert.equal(row.index_value, r.body.index);
});

test('research export is de-identified', async () => {
  const researcher = await as('research@demo.ngrm.in');
  const r = await researcher('GET', '/api/research/export');
  assert.equal(r.status, 200);
  assert.ok(r.body.participants > 0);
  assert.ok(!/@|"name"|email/.test(JSON.stringify(r.body)));
});

test('a student can export and then delete their account', async () => {
  const c = await as('new@demo.ngrm.in');
  const exp = await c('GET', '/api/me/export');
  assert.equal(exp.status, 200); assert.ok(exp.body.consents.length > 0);
  assert.equal((await c('DELETE', '/api/me', {})).status, 400);
  assert.equal((await c('DELETE', '/api/me', { confirm: 'DELETE' })).status, 200);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM users WHERE email = 'new@demo.ngrm.in'").n, 0);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM consents c LEFT JOIN users u ON u.id = c.user_id WHERE u.id IS NULL").n, 0);
});

test('a skill verified by assessment cannot be overwritten, and saving keeps questionnaire answers', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const r = await student('PUT', '/api/me/profile', { prog: 'ba-psy', year: 2, cgpa: 7.6, role: 'hr', skills: [55, 100, 60, 45], comm: '', clarity: 55 });
  assert.equal(r.body.profile.skills[1], 72);
  assert.deepEqual(r.body.profile.verifiedSkills, [1]);
  assert.deepEqual(r.body.profile.ocean, { o: 72, c: 68, e: 48, a: 74, n: 55 });
  assert.equal(r.body.score.index, 36.9);
});

test('out-of-range and junk profile values are cleaned, and a clarity of 0 counts as 0', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const r = await student('PUT', '/api/me/profile', { prog: 'nope', year: 9, cgpa: 7.6, role: 'astronaut', skills: ['x', -5, 200, '70'], comm: 'abc', clarity: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.prog, 'ba-psy'); assert.equal(r.body.profile.year, 3); assert.equal(r.body.profile.cgpa, 7.6); assert.equal(r.body.profile.role, 'hr');
  assert.deepEqual(r.body.profile.skills, [55, 72, 100, 70]);
  assert.equal(r.body.profile.comm, null);
  assert.equal(r.body.score.factors.clarity, 0);
  await student('PUT', '/api/me/profile', { prog: 'ba-psy', year: 2, cgpa: 7.6, role: 'hr', skills: [55, 72, 60, 45], comm: '', clarity: 55 });
});

test('evidence counts only once a mentor verifies it; made-up items and impossible dates do not move the score', async () => {
  const student = await as('ananya@demo.ngrm.in'), mentor = await as('kavya@demo.ngrm.in');
  const before = (await student('GET', '/api/me/profile')).body.score;
  for (const completedOn of ['2031-01-01', '1900-01-01', '2026-02-31']) assert.equal((await student('POST', '/api/me/evidence', { type: 'internship', title: 'Dated oddly', completedOn })).status, 400, completedOn);
  const list = (await student('POST', '/api/me/evidence', { type: 'internship', title: 'Summer HR internship', completedOn: '2026-06-30' })).body;
  const id = list[list.length - 1].id;
  for (let i = 0; i < 5; i++) await student('POST', '/api/me/evidence', { type: 'role', title: 'Invented club role ' + i });
  const pending = (await student('GET', '/api/me/profile')).body.score;
  assert.equal(pending.index, before.index, 'unverified items change nothing');
  assert.equal(pending.counts.internship, before.counts.internship);
  assert.equal((await mentor('POST', '/api/mentor/evidence/' + id, { action: 'needs_proof' })).status, 200);
  assert.equal((await student('PATCH', '/api/me/evidence/' + id, { fileName: '' })).status, 400);
  const back = await student('PATCH', '/api/me/evidence/' + id, { fileName: 'offer-letter.pdf' });
  assert.equal(back.body.find((e) => e.id === id).status, 'pending');
  assert.equal((await mentor('POST', '/api/mentor/evidence/' + id, { action: 'verify' })).status, 200);
  const verified = (await student('GET', '/api/me/profile')).body.score;
  assert.equal(verified.counts.internship, before.counts.internship + 1);
  assert.equal(verified.factors.experience, 50);
  h.run("DELETE FROM evidence WHERE user_id = 1 AND (title LIKE 'Invented club role%' OR id = ?)", id);
});

test('bad mentor and admin input is refused instead of crashing', async () => {
  const mentor = await as('kavya@demo.ngrm.in'), admin = await as('admin@demo.ngrm.in');
  assert.equal((await mentor('PATCH', '/api/mentor/reviews/1/not-a-rule', { action: 'approve' })).status, 404);
  for (const threshold of ['abc', -5, 101, '']) assert.equal((await admin('PATCH', '/api/admin/rules/course', { threshold })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/rules/course', { threshold: 65 })).body.threshold, 65);
  await admin('PATCH', '/api/admin/rules/course', { threshold: 60 });
  assert.equal((await admin('GET', '/api/admin/audit?limit=-1')).body.length, 1);
});

test('the counsellor option is always offered', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const items = (await student('GET', '/api/me/recommendations')).body.items;
  assert.ok(items.some((x) => x.id === 'counsellor' && x.always));
});

test('admins add colleges and people; a bad line saves nothing', async () => {
  const admin = await as('admin@demo.ngrm.in');
  assert.equal((await admin('POST', '/api/admin/orgs', { kind: 'institution', name: 'Pilot University', city: 'Tumakuru' })).status, 201);
  assert.equal((await admin('POST', '/api/admin/orgs', { kind: 'institution', name: 'pilot university', city: 'X' })).status, 409);
  const bad = await admin('POST', '/api/admin/users', { rows: [{ name: 'Good One', email: 'good@pilot.edu', role: 'student', org: 'Pilot University' }, { name: 'Bad', email: 'nope', role: 'student', org: 'Pilot University' }] });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /Line 2/);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM users WHERE email = 'good@pilot.edu'").n, 0);
  const wrongCollege = await admin('POST', '/api/admin/users', { rows: [{ name: 'S', email: 's@pilot.edu', role: 'student', org: 'Pilot University', mentorEmail: 'kavya@demo.ngrm.in' }] });
  assert.match(wrongCollege.body.error, /different college/);
  const ok = await admin('POST', '/api/admin/users', { rows: [{ name: 'Pilot Mentor', email: 'mentor@pilot.edu', role: 'mentor', org: 'Pilot University' }, { name: 'Pilot Student', email: 'Student@Pilot.edu', role: 'student', org: 'Pilot University', mentorEmail: 'mentor@pilot.edu' }] });
  assert.equal(ok.status, 201); assert.equal(ok.body.added, 2);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM mentor_links m JOIN users s ON s.id = m.student_id JOIN users t ON t.id = m.mentor_id WHERE s.email = 'student@pilot.edu' AND t.email = 'mentor@pilot.edu'").n, 1);
  const student = client();
  const code = (await student('POST', '/api/auth/request-code', { email: 'student@pilot.edu' })).body.devCode;
  assert.equal((await student('POST', '/api/auth/verify', { email: 'student@pilot.edu', code })).status, 200);
  const placement = await as('placement@demo.ngrm.in');
  assert.equal((await placement('POST', '/api/admin/users', { rows: [{ name: 'X', email: 'x@x.in', role: 'admin' }] })).status, 403, 'only admins add people');
});

test('introductions: one request per role a month, students reply, only their placement cell sees who', async () => {
  const employer = await as('recruiter@demo.ngrm.in'), placement = await as('placement@demo.ngrm.in'), student = await as('ananya@demo.ngrm.in');
  assert.equal((await employer('POST', '/api/employer/intros', { role: 'hr' })).status, 201);
  assert.equal((await employer('POST', '/api/employer/intros', { role: 'hr' })).status, 409);
  assert.deepEqual((await student('GET', '/api/me/intro-requests')).body, { optedIn: false, requests: [] });
  await student('PATCH', '/api/me/intro-opt-in', { optIn: true });
  const reqs = (await student('GET', '/api/me/intro-requests')).body.requests;
  const req = reqs.find((r) => r.employer.startsWith('Sample Employer A'));
  assert.ok(req && req.interested === false);
  assert.equal((await student('POST', '/api/me/intro-requests/' + req.id, { interested: true })).status, 200);
  const seen = (await placement('GET', '/api/college/intro-requests')).body.find((r) => r.id === req.id);
  assert.deepEqual(seen.students.map((u) => u.name), ['Ananya Rao']);
  const mine = (await employer('GET', '/api/employer/intros')).body.find((r) => r.id === req.id);
  assert.equal(mine.replies, null, 'employer sees no names and no count under 5');
  assert.ok(!/Ananya|@/.test(JSON.stringify((await employer('GET', '/api/employer/intros')).body)));
  // Withdrawing consent hides the reply again, and saving the consent form keeps the opt-in in step.
  await student('POST', '/api/me/consents', { purposes: { introductions: false }, isAdult: true });
  assert.equal((await placement('GET', '/api/college/intro-requests')).body.find((r) => r.id === req.id).students.length, 0);
  await student('POST', '/api/me/consents', { purposes: { introductions: true }, isAdult: true });
  assert.equal(h.get('SELECT opt_in_intros FROM profiles WHERE user_id = 1').opt_in_intros, 1);
  await student('PATCH', '/api/me/intro-opt-in', { optIn: false });
});

test('college views leave out programmes under 5, so no single score can be worked out', async () => {
  const id = Number(h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('solo@demo.ngrm.in', 'Solo BBA', 'student', 1)").lastInsertRowid);
  h.run("INSERT INTO consents (user_id, purpose, granted, is_adult) VALUES (?, 'profile', 1, 1)", id);
  h.run("INSERT INTO profiles (user_id, programme, year, cgpa, target_role) VALUES (?, 'bba', 1, 9.9, 'hr')", id);
  const placement = await as('placement@demo.ngrm.in');
  const all = (await placement('GET', '/api/college/cohort?programme=all')).body;
  const parts = await Promise.all(['ba-psy', 'bcom', 'bsc-cs', 'bba', 'btech', 'ba-jour'].map((p) => placement('GET', '/api/college/cohort?programme=' + p)));
  const sum = parts.reduce((t, r) => t + (r.body.n || 0), 0);
  assert.ok(Math.abs(all.n - sum) <= 10, 'the all-programmes total covers only the visible programmes (each figure is rounded to 5)');
  assert.equal(all.smallProgrammesLeftOut, true);
  const b = all.bands; assert.ok(Object.values(b).filter((v) => v === null).length !== 1, 'never exactly one hidden band');
  h.run('DELETE FROM users WHERE id = ?', id);
});

test('changing target role starts a fresh plan; a partial save keeps other fields', async () => {
  const student = await as('ananya@demo.ngrm.in');
  await student('PATCH', '/api/me/recommendations/internship', { action: 'accept' });
  assert.ok(h.get("SELECT COUNT(*) AS n FROM recommendation_states WHERE user_id = 1").n > 0);
  const kept = await student('PUT', '/api/me/profile', { cgpa: 7.6 });
  assert.equal(kept.body.profile.year, 2); assert.equal(kept.body.profile.clarity, 55);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM recommendation_states WHERE user_id = 1").n > 0, true, 'same role keeps the plan');
  await student('PUT', '/api/me/profile', { role: 'data', skills: [50, 50, 50, 50] });
  assert.equal(h.get("SELECT COUNT(*) AS n FROM recommendation_states WHERE user_id = 1").n, 0);
  await student('PUT', '/api/me/profile', { prog: 'ba-psy', year: 2, cgpa: 7.6, role: 'hr', skills: [55, 72, 60, 45], comm: '', clarity: 55 });
  h.run("INSERT INTO recommendation_states (user_id, rule_id, mentor_status, mentor_note, mentor_id, mentor_at) VALUES (1, 'project', 'approved', 'Good fit.', 2, datetime('now'))");
});

test('an under-18 student keeps their guardian on record and cannot opt in without one', async () => {
  h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('minor@demo.ngrm.in', 'Minor Student', 'student', 1)");
  const c = await as('minor@demo.ngrm.in');
  await c('POST', '/api/me/consents', { purposes: { profile: true }, isAdult: false, guardianName: 'Parent Name' });
  const cons = (await c('GET', '/api/me/consents')).body;
  assert.equal(cons.isAdult, false); assert.equal(cons.guardianName, 'Parent Name');
  await c('GET', '/api/me/profile');
  assert.equal((await c('PATCH', '/api/me/intro-opt-in', { optIn: true })).status, 200);
  const row = h.get("SELECT is_adult, guardian_name FROM consents WHERE purpose = 'introductions' ORDER BY id DESC LIMIT 1");
  assert.equal(row.is_adult, 0); assert.equal(row.guardian_name, 'Parent Name');
  h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('minor2@demo.ngrm.in', 'Minor Two', 'student', 1)");
  const c2 = await as('minor2@demo.ngrm.in');
  const id2 = h.get("SELECT id FROM users WHERE email = 'minor2@demo.ngrm.in'").id;
  h.run("INSERT INTO consents (user_id, purpose, granted, is_adult) VALUES (?, 'profile', 1, 0)", id2);
  await c2('GET', '/api/me/profile');
  assert.equal((await c2('PATCH', '/api/me/intro-opt-in', { optIn: true })).status, 400);
});

test('the data export includes study baselines and introduction replies', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const exp = (await student('GET', '/api/me/export')).body;
  assert.ok(Array.isArray(exp.studyBaselines)); assert.ok(Array.isArray(exp.introductionReplies));
});

test('the counsellor referral cannot be switched off', async () => {
  const admin = await as('admin@demo.ngrm.in');
  assert.equal((await admin('PATCH', '/api/admin/rules/counsellor', { active: false })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/rules/counsellor', { threshold: 50 })).status, 200);
  await admin('PATCH', '/api/admin/rules/counsellor', { threshold: 40 });
});

test('admins can find and remove accounts, including a mentor with past reviews, but not themselves', async () => {
  const admin = await as('admin@demo.ngrm.in');
  await admin('POST', '/api/admin/users', { rows: [{ name: 'Leaving Mentor', email: 'leaving@demo.ngrm.in', role: 'mentor', org: 'Sample College, Bengaluru' }] });
  const found = (await admin('GET', '/api/admin/people?q=leaving')).body.recent;
  assert.equal(found.length, 1);
  const mid = found[0].id;
  h.run('INSERT INTO mentor_links (mentor_id, student_id) VALUES (?, 1)', mid);
  h.run("INSERT OR REPLACE INTO recommendation_states (user_id, rule_id, mentor_status, mentor_note, mentor_id) VALUES (1, 'leadership', 'approved', 'Yes', ?)", mid);
  assert.equal((await admin('DELETE', '/api/admin/users/' + mid)).status, 200);
  assert.equal(h.get("SELECT mentor_id, mentor_note FROM recommendation_states WHERE user_id = 1 AND rule_id = 'leadership'").mentor_note, 'Yes', 'the review text stays with the student');
  const self = h.get("SELECT id FROM users WHERE email = 'admin@demo.ngrm.in'").id;
  assert.equal((await admin('DELETE', '/api/admin/users/' + self)).status, 400);
});

test('broken request bodies get a plain answer, not a crash', async () => {
  const r = await fetch(base + '/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /could not be read/);
});

test('a new production database gets the rules and the first admin, and no sample people', () => {
  const { bootstrap } = require('../server/seed');
  const db2 = open(':memory:'), h2 = helpers(db2);
  assert.equal(bootstrap(db2, { ADMIN_EMAIL: 'First@Admin.org', ADMIN_NAME: 'First Admin' }), 'first@admin.org');
  assert.equal(bootstrap(db2, { ADMIN_EMAIL: 'first@admin.org' }), null, 'running again changes nothing');
  assert.equal(h2.get('SELECT COUNT(*) AS n FROM rules').n, 9);
  assert.deepEqual(h2.all('SELECT email, role FROM users').map((u) => ({ ...u })), [{ email: 'first@admin.org', role: 'admin' }]);
});

test('AI wording: only with consent, never sees name or email, cached, unsafe text rejected, removed on withdrawal', async () => {
  const realFetch = global.fetch; const sent = []; let mode = 'good';
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return realFetch(url, opts);
    sent.push(opts.body);
    const reason = JSON.parse(opts.body).contents[0].parts[0].text.split('Explanation: ')[1];
    const text = mode === 'good' ? 'In plain words: ' + reason : 'This adds 99 points, see https://x.example';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const student = await as('ananya@demo.ngrm.in');
    await student('POST', '/api/me/consents', { purposes: { ai_wording: false }, isAdult: true });
    let items = (await student('GET', '/api/me/recommendations')).body.items;
    assert.ok(items.every((x) => x.aiWhy === null)); assert.equal(sent.length, 0, 'nothing sent without consent');
    await student('POST', '/api/me/consents', { purposes: { ai_wording: true }, isAdult: true });
    items = (await student('GET', '/api/me/recommendations')).body.items;
    assert.ok(items.length > 0 && items.every((x) => x.aiWhy && x.aiWhy.startsWith('In plain words: ')));
    assert.ok(sent.length === items.length && sent.every((b) => !/Ananya|Rao|@/.test(b)), 'no name or email in what is sent');
    const before = sent.length; await student('GET', '/api/me/recommendations');
    assert.equal(sent.length, before, 'second load uses the saved wording');
    await student('POST', '/api/me/consents', { purposes: { ai_wording: false }, isAdult: true });
    assert.equal(h.get('SELECT COUNT(*) AS n FROM recommendation_states WHERE user_id = 1 AND ai_text IS NOT NULL').n, 0, 'withdrawal deletes saved wording');
    mode = 'bad'; await student('POST', '/api/me/consents', { purposes: { ai_wording: true }, isAdult: true });
    items = (await student('GET', '/api/me/recommendations')).body.items;
    assert.ok(items.every((x) => x.aiWhy === null), 'unsafe rewrites fall back to the original');
    await student('POST', '/api/me/consents', { purposes: { ai_wording: false }, isAdult: true });
  } finally { global.fetch = realFetch; delete process.env.GEMINI_API_KEY; }
});

test('the study baseline is recorded once, and researchers count people, not rows', async () => {
  h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('study@demo.ngrm.in', 'Study Student', 'student', 1)");
  const c = await as('study@demo.ngrm.in');
  await c('POST', '/api/me/consents', { purposes: { profile: true, study: true }, isAdult: true });
  // A new student starts with nothing filled in, and nothing can be recorded until they say what they study and aim for.
  assert.deepEqual((await c('GET', '/api/me/profile')).body, { needsSetup: true });
  assert.equal((await c('PUT', '/api/me/profile', { cgpa: 8 })).status, 400);
  assert.equal((await c('POST', '/api/me/baseline')).status, 404);
  const first = (await c('PUT', '/api/me/profile', { prog: 'bsc-cs', year: 2, role: 'dev' })).body;
  assert.equal(first.profile.role, 'dev'); assert.deepEqual(first.profile.skillsRated, [false, false, false, false]); assert.equal(first.profile.cgpa, null);
  assert.equal((await c('PUT', '/api/me/profile', { skills: [70, '', '', ''] })).body.profile.skillsRated.join(), 'true,false,false,false');
  assert.equal((await c('POST', '/api/me/baseline')).status, 201);
  const again = await c('POST', '/api/me/baseline');
  assert.equal(again.status, 409); assert.match(again.body.error, /only once/);
  const r = (await (await as('research@demo.ngrm.in'))('GET', '/api/research/export')).body;
  assert.equal(r.participants, new Set(r.rows.map((x) => x.participant)).size);
});

test('mentors record college assessments; the student cannot overwrite or delete them', async () => {
  const mentor = await as('kavya@demo.ngrm.in'), student = await as('ananya@demo.ngrm.in');
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: 1, what: 3, value: 150 })).status, 400);
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: 1, what: 9, value: 50 })).status, 400);
  const other = h.get("SELECT u.id FROM users u WHERE u.role = 'student' AND u.id NOT IN (SELECT student_id FROM mentor_links) LIMIT 1").id;
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: other, what: 0, value: 50 })).status, 404);
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: 1, what: 3, value: 66 })).status, 201);
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: 1, what: 'communication', value: 74 })).status, 201);
  const put = await student('PUT', '/api/me/profile', { prog: 'ba-psy', year: 2, cgpa: 7.6, role: 'hr', skills: [55, 72, 60, 99], comm: 100, clarity: 55 });
  assert.equal(put.body.profile.skills[3], 66); assert.equal(put.body.profile.comm, 74); assert.equal(put.body.profile.commVerified, true);
  assert.deepEqual(put.body.profile.verifiedSkills.sort(), [1, 3]);
  const a = h.get("SELECT id FROM evidence WHERE user_id = 1 AND skill_role = 'communication'").id;
  assert.equal((await student('DELETE', '/api/me/evidence/' + a)).status, 404);
  // A second result replaces the first instead of piling up.
  await mentor('POST', '/api/mentor/assessments', { studentId: 1, what: 3, value: 70 });
  assert.equal(h.get("SELECT COUNT(*) AS n FROM evidence WHERE user_id = 1 AND type = 'assessment' AND skill_index = 3").n, 1);
  h.run("DELETE FROM evidence WHERE user_id = 1 AND type = 'assessment' AND (skill_index = 3 OR skill_role = 'communication')");
  await student('PUT', '/api/me/profile', { prog: 'ba-psy', year: 2, cgpa: 7.6, role: 'hr', skills: [55, 72, 60, 45], comm: '', clarity: 55 });
});

test('API answers are never cached by the browser', async () => {
  const r = await fetch(base + '/api/meta');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('one network cannot flood inboxes with sign-in codes', async () => {
  const db2 = open(':memory:'); seed(db2);
  const s2 = createApp(db2, { demoMode: true, emailCodes: true, sendCode: () => {} }).listen(0); await new Promise((r) => s2.once('listening', r));
  const b2 = 'http://localhost:' + s2.address().port; const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await fetch(b2 + '/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `x${i}@example.com` }) })).status);
  s2.close();
  assert.equal(statuses.filter((s) => s === 200).length, 30); assert.equal(statuses[30], 429);
});

test('names like "toString" are never accepted as roles, types or purposes', async () => {
  const student = await as('ananya@demo.ngrm.in'), employer = await as('recruiter@demo.ngrm.in'), admin = await as('admin@demo.ngrm.in');
  const r = await student('PUT', '/api/me/profile', { role: 'toString' });
  assert.equal(r.status, 200); assert.equal(r.body.profile.role, 'hr');
  assert.equal((await student('GET', '/api/me/recommendations')).status, 200);
  assert.equal((await (await as('kavya@demo.ngrm.in'))('GET', '/api/mentor/queue')).status, 200);
  assert.equal((await employer('POST', '/api/employer/demand', { role: 'toString', skills: [], openings: 1 })).status, 400);
  assert.equal((await employer('GET', '/api/employer/supply?role=constructor')).status, 400);
  assert.equal((await student('POST', '/api/me/consents', { purposes: { constructor: true } })).status, 400);
  assert.equal((await student('POST', '/api/me/evidence', { type: 'constructor', title: 'x' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/users', { rows: [null] })).status, 400);
});

test('questionnaire answers are never invented: partial or missing traits store nothing', async () => {
  h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('fresh@demo.ngrm.in', 'Fresh Student', 'student', 1)");
  const c = await as('fresh@demo.ngrm.in');
  await c('POST', '/api/me/consents', { purposes: { profile: true, psychometric: true }, isAdult: true });
  let r = await c('PUT', '/api/me/profile', { prog: 'ba-psy', year: 1, role: 'hr', cgpa: 8 });
  assert.equal(r.body.profile.ocean, null); assert.equal(r.body.score.factors.psychometric, null); assert.equal(r.body.score.factors.communication, null);
  r = await c('PUT', '/api/me/profile', { ocean: { o: 60, c: 60 } });
  assert.equal(r.body.profile.ocean, null, 'partial answers are not saved');
  r = await c('PUT', '/api/me/profile', { ocean: { o: 60, c: 60, e: 60, a: 60, n: 40 } });
  assert.deepEqual(r.body.profile.ocean, { o: 60, c: 60, e: 60, a: 60, n: 40 });
  r = await c('PUT', '/api/me/profile', { cgpa: 8.1 });
  assert.deepEqual(r.body.profile.ocean, { o: 60, c: 60, e: 60, a: 60, n: 40 }, 'later saves keep them');
});

test('withdrawing questionnaire consent removes the answers from recorded scores and the study baseline too', async () => {
  const c = await as('fresh@demo.ngrm.in');
  await c('POST', '/api/me/consents', { purposes: { study: true } });
  await c('POST', '/api/me/score'); await c('POST', '/api/me/baseline');
  await c('POST', '/api/me/consents', { purposes: { psychometric: false } });
  const id = h.get("SELECT id FROM users WHERE email = 'fresh@demo.ngrm.in'").id;
  for (const r of h.all('SELECT inputs_json, factors_json FROM score_runs WHERE user_id = ?', id)) {
    assert.ok(!/"o":60/.test(r.inputs_json)); assert.equal(JSON.parse(r.factors_json).psychometric, null);
  }
  const exp = (await c('GET', '/api/me/export')).body;
  assert.ok(exp.scoreRuns.length >= 2 && exp.scoreRuns.every((s) => s.inputs && s.inputs.profile));
  const ananya = (await (await as('ananya@demo.ngrm.in'))('GET', '/api/me/export')).body;
  const reviewed = ananya.recommendationDecisions.find((d) => d.rule_id === 'project');
  assert.equal(reviewed.mentor_name, 'Dr. Kavya S.', 'export names the mentor who reviewed');
});

test('consent changes that do not mention age keep an under-18 student as under 18', async () => {
  const c = await as('minor@demo.ngrm.in');
  const r = await c('POST', '/api/me/consents', { purposes: { ai_wording: true } });
  assert.equal(r.body.isAdult, false); assert.equal(r.body.guardianName, 'Parent Name');
});

test('college views cannot be compared before and after one student leaves', async () => {
  const placement = await as('placement@demo.ngrm.in');
  const before = (await placement('GET', '/api/college/cohort?programme=ba-psy')).body;
  assert.equal(before.n % 5, 0); assert.ok(Number.isInteger(before.avgIndex));
  for (const v of Object.values(before.factors)) assert.ok(Number.isInteger(v));
  assert.ok(before.noInternshipPct === null || before.noInternshipPct % 5 === 0);
  // One student withdrawing changes nothing visible, so their figures cannot be subtracted out.
  const student = await as('ananya@demo.ngrm.in');
  await student('POST', '/api/me/consents', { purposes: { profile: false } });
  const after = (await placement('GET', '/api/college/cohort?programme=ba-psy')).body;
  await student('POST', '/api/me/consents', { purposes: { profile: true } });
  const nb = before.n * before.avgIndex, na = after.n * after.avgIndex;
  assert.ok(after.n === before.n || Math.abs(nb - na) > 100, 'either nothing changed or the difference is meaningless');
  const sup = (await (await as('recruiter@demo.ngrm.in'))('GET', '/api/employer/supply?role=hr')).body;
  for (const k of sup.skills || []) assert.ok(k.sharePct === null || k.sharePct % 5 === 0);
});

test('replies to introduction requests older than 90 days are refused', async () => {
  const student = await as('ananya@demo.ngrm.in');
  await student('PATCH', '/api/me/intro-opt-in', { optIn: true });
  const old = Number(h.run("INSERT INTO intro_requests (employer_id, role, created_at) VALUES (1, 'hr', datetime('now', '-120 days'))").lastInsertRowid);
  assert.equal((await student('POST', '/api/me/intro-requests/' + old, { interested: true })).status, 404);
  await student('PATCH', '/api/me/intro-opt-in', { optIn: false });
});

test('sample study baselines store their inputs, like real ones', () => {
  const rows = h.all('SELECT s.inputs_json FROM baselines b JOIN score_runs s ON s.id = b.score_run_id');
  assert.ok(rows.length > 50 && rows.every((r) => JSON.parse(r.inputs_json).profile));
});

test('production refuses a short or example session secret', () => {
  const { spawnSync } = require('node:child_process');
  for (const secret of ['short', 'change-me-to-a-long-random-string-xxxxxxxxxx']) {
    const r = spawnSync(process.execPath, ['--no-warnings', 'server/index.js'], { env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: secret, ORG_NAME: 'Test Org', PRIVACY_CONTACT: 'p@test.org', DEMO_MODE: 'false', DEV_SHOW_OTP: 'false', DB_FILE: ':memory:', PORT: '0' }, timeout: 5000, encoding: 'utf8' });
    assert.match(r.stderr, /Refusing to start/);
  }
});

test('proof files: real PDF/PNG/JPEG only, private to the student and their mentor, deleted with the item', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const list = (await student('POST', '/api/me/evidence', { type: 'certificate', title: 'Excel certificate' })).body;
  const id = list[list.length - 1].id;
  const cookieOf = async (email) => (await fetch(base + '/api/auth/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })).headers.get('set-cookie').split(';')[0];
  const A = await cookieOf('ananya@demo.ngrm.in'), K = await cookieOf('kavya@demo.ngrm.in'), E = await cookieOf('recruiter@demo.ngrm.in'), P = await cookieOf('placement@demo.ngrm.in');
  const put = (body, type, cookie = A) => fetch(base + `/api/me/evidence/${id}/file`, { method: 'PUT', headers: { cookie, 'content-type': type, 'x-file-name': encodeURIComponent('my "cert"/../x.pdf') }, body });
  assert.equal((await put(Buffer.from('<script>alert(1)</script>'), 'application/pdf')).status, 400, 'fake PDF refused');
  assert.equal((await put(Buffer.from('hello'), 'text/html')).status, 400, 'other types refused');
  assert.equal((await put(Buffer.alloc(6 * 1024 * 1024, 1), 'application/pdf')).status, 413, 'over 5 MB refused');
  const pdf = Buffer.from('%PDF-1.4 test file');
  const ok = await put(pdf, 'application/pdf'); assert.equal(ok.status, 200);
  const item = (await ok.json()).find((e) => e.id === id);
  assert.equal(item.has_file, 1); assert.ok(!/[\\/"]/.test(item.file_name));
  const get = (cookie) => fetch(base + `/api/evidence/${id}/file`, { headers: { cookie } });
  const mine = await get(A); assert.equal(mine.status, 200); assert.deepEqual(Buffer.from(await mine.arrayBuffer()), pdf);
  assert.match(mine.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await get(K)).status, 200, 'own mentor can open it');
  assert.equal((await get(E)).status, 403); assert.equal((await get(P)).status, 403);
  const stored = h.get('SELECT file_path FROM evidence WHERE id = ?', id).file_path;
  assert.ok(fs.existsSync(path.join(uploads, stored)));
  await student('DELETE', '/api/me/evidence/' + id);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!fs.existsSync(path.join(uploads, stored)), 'file is deleted with the item');
});

test('sign-in codes are emailed through the configured provider, and the code is never returned or logged', async () => {
  const mail = require('../server/mail');
  assert.equal(mail.provider({}), null); assert.equal(mail.provider({ RESEND_API_KEY: 'k' }), null, 'needs MAIL_FROM too');
  const realFetch = global.fetch; const calls = [];
  global.fetch = async (url, opts) => { calls.push([String(url), opts]); return new Response('{}', { status: 200 }); };
  try {
    assert.equal(await mail.sendCode('s@college.edu', '123456', { MAIL_FROM: 'no-reply@ngrm.in', RESEND_API_KEY: 'rk' }), true);
    assert.equal(await mail.sendCode('s@college.edu', '123456', { MAIL_FROM: 'no-reply@ngrm.in', BREVO_API_KEY: 'bk' }), true);
  } finally { global.fetch = realFetch; }
  assert.match(calls[0][0], /api\.resend\.com/); assert.equal(calls[0][1].headers.authorization, 'Bearer rk'); assert.match(calls[0][1].body, /123456/);
  assert.match(calls[1][0], /api\.brevo\.com/); assert.equal(calls[1][1].headers['api-key'], 'bk');
});

test('admins can set, change and clear a student\'s mentor, only within the same college', async () => {
  const admin = await as('admin@demo.ngrm.in');
  const sid = h.get("SELECT u.id FROM users u WHERE u.role = 'student' AND u.institution_id = 1 AND u.id NOT IN (SELECT student_id FROM mentor_links) LIMIT 1").id;
  assert.equal((await admin('PUT', `/api/admin/users/${sid}/mentor`, { mentorEmail: 'nobody@x.in' })).status, 400);
  assert.equal((await admin('PUT', `/api/admin/users/${sid}/mentor`, { mentorEmail: 'mentor@pilot.edu' })).status, 400, 'other college refused');
  assert.equal((await admin('PUT', `/api/admin/users/${sid}/mentor`, { mentorEmail: 'Kavya@demo.ngrm.in' })).body.mentor, 'kavya@demo.ngrm.in');
  assert.equal(h.get('SELECT COUNT(*) AS n FROM mentor_links WHERE student_id = ?', sid).n, 1);
  assert.equal((await admin('GET', '/api/admin/people?q=' + encodeURIComponent(h.get('SELECT email FROM users WHERE id = ?', sid).email))).body.recent[0].mentor, 'kavya@demo.ngrm.in');
  assert.equal((await admin('PUT', `/api/admin/users/${sid}/mentor`, { mentorEmail: '' })).body.mentor, null);
  assert.equal(h.get('SELECT COUNT(*) AS n FROM mentor_links WHERE student_id = ?', sid).n, 0);
  assert.equal((await (await as('kavya@demo.ngrm.in'))('PUT', `/api/admin/users/${sid}/mentor`, { mentorEmail: '' })).status, 403);
});

test('course steps carry real, checked courses for the exact weak skill, plus live search links', async () => {
  const { bootstrap } = require('../server/seed'); bootstrap(db, {});
  const catalogue = require('../server/courses');
  assert.ok(catalogue.length >= 20);
  for (const [role, idx, title, provider, url] of catalogue) { assert.ok(title && provider && /^https:\/\//.test(url)); assert.ok(D.ROLES[role].skills[idx]); }
  const student = await as('ananya@demo.ngrm.in');
  // Ananya's weakest HR skill is labour law (index 3).
  const course = (await student('GET', '/api/me/recommendations')).body.items.find((x) => x.id === 'course');
  assert.equal(course.learn.skill, 'Labour law basics');
  assert.ok(course.learn.courses.some((c) => c.title === 'Legal Essentials for Human Resource Management'));
  assert.ok(course.learn.searches.length >= 3 && course.learn.searches.every((s) => s.url.startsWith('https://') && /Labour%20law%20basics/.test(s.url)));
  const admin = await as('admin@demo.ngrm.in');
  assert.equal((await admin('POST', '/api/admin/courses', { role: 'hr', skillIndex: 3, title: 'X', provider: 'Y', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await student('GET', '/api/admin/courses')).status, 403);
  const added = await admin('POST', '/api/admin/courses', { role: 'hr', skillIndex: 3, title: 'New labour codes', provider: 'Test', url: 'https://example.org/c', weeks: 4 });
  assert.equal(added.status, 201);
  assert.ok((await student('GET', '/api/me/recommendations')).body.items.find((x) => x.id === 'course').learn.courses.some((c) => c.title === 'New labour codes'), 'students see a new course at once');
  await admin('DELETE', '/api/admin/courses/' + added.body.id);
  bootstrap(db, {});
  assert.equal(h.get("SELECT COUNT(*) AS n FROM courses WHERE title = 'Intro to SQL'").n, 1, 'restarting never duplicates the catalogue');
});

test('the privacy notice is public and names the operator; production will not start without one', async () => {
  const page = await fetch(base + '/privacy.html'); assert.equal(page.status, 200);
  assert.match(await page.text(), /Who can see what/);
  assert.ok('operator' in (await (await fetch(base + '/api/meta')).json()));
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), DEMO_MODE: 'false', DEV_SHOW_OTP: 'false', DB_FILE: ':memory:', PORT: '0', ORG_NAME: '', PRIVACY_CONTACT: '' };
  assert.match(spawnSync(process.execPath, ['--no-warnings', 'server/index.js'], { env, timeout: 5000, encoding: 'utf8' }).stderr, /ORG_NAME/);
});

test('live course feed: fetched once a day per skill, shown on the course step, and safe when the provider fails', async () => {
  const { makeFeeds, searchCoursera } = require('../server/feeds');
  const realFetch = global.fetch; let calls = 0, mode = 'ok';
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://api.coursera.org/')) return realFetch(url, opts);
    calls++; assert.match(String(url), /q=search&query=Labour%20law%20basics/); assert.ok(!/ananya|@/i.test(String(url)), 'only the skill name is sent');
    if (mode === 'down') return new Response('nope', { status: 503 });
    if (mode === 'odd') return new Response(JSON.stringify({ unexpected: true }), { status: 200 });
    return new Response(JSON.stringify({ elements: [{ name: 'Employment Law Basics', slug: 'employment-law' }, { name: 'Bad', slug: '../../evil' }, { name: 5, slug: 'x' }] }), { status: 200 });
  };
  process.env.COURSE_FEED = 'coursera';
  try {
    const rows = await searchCoursera('Labour law basics');
    assert.deepEqual(rows, [{ title: 'Employment Law Basics', provider: 'Coursera', url: 'https://www.coursera.org/learn/employment-law' }], 'malformed entries are dropped');
    const feeds = makeFeeds(h);
    assert.deepEqual(feeds.forSkill('Labour law basics').courses, [], 'nothing stored yet: students are not kept waiting');
    await new Promise((r) => setTimeout(r, 50));
    const before = calls;
    assert.equal(feeds.forSkill('Labour law basics').courses[0].title, 'Employment Law Basics');
    assert.equal(calls, before, 'a fresh result is reused, not fetched again');
    assert.equal(feeds.status().ok, 1);
    mode = 'down'; await assert.rejects(feeds.refresh('Labour law basics')); assert.equal(feeds.status().ok, 0);
    mode = 'odd'; await assert.rejects(feeds.refresh('Labour law basics'));
    assert.equal(feeds.forSkill('Labour law basics').courses.length, 1, 'a failure keeps the last good list');
    const student = await as('ananya@demo.ngrm.in');
    const step = (await student('GET', '/api/me/recommendations')).body.items.find((x) => x.id === 'course');
    assert.equal(step.learn.live[0].url, 'https://www.coursera.org/learn/employment-law');
    assert.equal(step.learn.demand.skill, 'Labour law basics');
  } finally { global.fetch = realFetch; process.env.COURSE_FEED = 'off'; h.run('DELETE FROM live_courses'); }
});

test('live activity: exact for admins, rounded and college-only for placement cells, closed to everyone else', async () => {
  const admin = await as('admin@demo.ngrm.in'), placement = await as('placement@demo.ngrm.in'), student = await as('ananya@demo.ngrm.in'), employer = await as('recruiter@demo.ngrm.in');
  const before = (await admin('GET', '/api/admin/activity')).body;
  await student('PUT', '/api/me/profile', { clarity: 56 });
  assert.equal((await student('POST', '/api/me/score')).body.alreadyRecorded, undefined);
  const dup = await student('POST', '/api/me/score');
  assert.equal(dup.body.alreadyRecorded, true, 'the same score is not recorded twice');
  await student('PUT', '/api/me/profile', { clarity: 55 });
  const after = (await admin('GET', '/api/admin/activity')).body;
  assert.equal(after.today.scores, before.today.scores + 1, 'a new action shows up at once');
  assert.ok(after.days.length >= 1 && after.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
  assert.ok(!/ananya|@|Rao/i.test(JSON.stringify(after)), 'counts only, no names');
  const c = (await placement('GET', '/api/college/activity')).body;
  for (const k of ['activeStudents', 'scores', 'evidence', 'decisions', 'awaitingCheck']) assert.ok(c[k] === null || (c[k] >= 5 && c[k] % 5 === 0), k + ' is hidden or rounded');
  assert.equal((await student('GET', '/api/admin/activity')).status, 403);
  assert.equal((await employer('GET', '/api/college/activity')).status, 403);
  assert.equal((await student('GET', '/api/admin/feeds')).status, 403);
});

test('passwords: optional for every role, hashed, guess-limited, and reset by emailed code', async () => {
  const pw = 'river stones at dawn';
  for (const email of ['ananya@demo.ngrm.in', 'kavya@demo.ngrm.in', 'placement@demo.ngrm.in', 'recruiter@demo.ngrm.in', 'research@demo.ngrm.in', 'admin@demo.ngrm.in']) {
    const c = await as(email);
    assert.equal((await c('GET', '/api/me')).body.user.hasPassword, false);
    assert.equal((await c('POST', '/api/me/password', { password: pw })).status, 200, email);
    const fresh = client();
    const r = await fresh('POST', '/api/auth/password', { email: email.toUpperCase(), password: pw });
    assert.equal(r.status, 200); assert.equal((await fresh('GET', '/api/me')).body.user.signedInWith, 'password');
  }
  const stored = h.get("SELECT p.hash FROM passwords p JOIN users u ON u.id = p.user_id WHERE u.email = 'ananya@demo.ngrm.in'").hash;
  assert.ok(stored.startsWith('scrypt$') && !stored.includes(pw), 'only a salted hash is stored');
  const c = client();
  for (const bad of ['short', 'aaaaaaaaaaaa', 'ananya-ananya-1']) { const s = await as('ananya@demo.ngrm.in'); assert.equal((await s('POST', '/api/me/password', { password: bad })).status, 400, bad); }
  // Unknown email, account without password, and wrong password all get the same answer.
  const wrong = await c('POST', '/api/auth/password', { email: 'ananya@demo.ngrm.in', password: 'not the password' });
  const ghost = await c('POST', '/api/auth/password', { email: 'ghost@example.com', password: 'not the password' });
  assert.equal(wrong.status, 400); assert.deepEqual(wrong.body, ghost.body);
  // Signed in by password: changing it needs the current one.
  const viaPw = client(); await viaPw('POST', '/api/auth/password', { email: 'kavya@demo.ngrm.in', password: pw });
  assert.equal((await viaPw('POST', '/api/me/password', { password: 'a different long one', current: 'wrong' })).status, 400);
  assert.equal((await viaPw('POST', '/api/me/password', { password: 'a different long one', current: pw })).status, 200);
  const old = client(); assert.equal((await old('POST', '/api/auth/password', { email: 'kavya@demo.ngrm.in', password: pw })).status, 400, 'old password stops working');
  // Forgot it: an emailed-code sign-in can set a new one without the old.
  const viaCode = await as('kavya@demo.ngrm.in');
  assert.equal((await viaCode('POST', '/api/me/password', { password: 'reset after forgetting' })).status, 200);
  assert.equal((await viaPw('GET', '/api/me')).body.user, null, 'other devices are signed out when the password changes');
  // Five wrong tries lock password sign-in for that email; the right password is refused until the wait is over.
  const g = client(); let last;
  for (let i = 0; i < 6; i++) last = await g('POST', '/api/auth/password', { email: 'research@demo.ngrm.in', password: 'guess number ' + i });
  assert.equal(last.status, 429);
  assert.equal((await g('POST', '/api/auth/password', { email: 'research@demo.ngrm.in', password: pw })).status, 429);
  h.run('DELETE FROM login_failures'); h.run('DELETE FROM passwords');
});

test('CGPA and career clarity can be corrected but not cleared, so a low value cannot be hidden', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const r = await student('PUT', '/api/me/profile', { cgpa: '', clarity: '' });
  assert.equal(r.body.profile.cgpa, 7.6); assert.equal(r.body.profile.clarity, 55);
  assert.equal((await student('PUT', '/api/me/profile', { cgpa: 7.7 })).body.profile.cgpa, 7.7);
  await student('PUT', '/api/me/profile', { cgpa: 7.6 });
});

test('students cannot enter their own communication score; employer openings must be a real number', async () => {
  const student = await as('ananya@demo.ngrm.in'), employer = await as('recruiter@demo.ngrm.in');
  const r = await student('PUT', '/api/me/profile', { comm: 100 });
  assert.equal(r.body.profile.comm, null); assert.equal(r.body.score.factors.communication, null);
  for (const openings of [-5, 'abc', 0, 2.5, 501]) assert.equal((await employer('POST', '/api/employer/demand', { role: 'hr', skills: ['Labour law basics'], openings })).status, 400, String(openings));
});

test('the research export gives scores in bands of 5, so a known CGPA cannot pick out one record', async () => {
  const rows = (await (await as('research@demo.ngrm.in'))('GET', '/api/research/export')).body.rows;
  assert.ok(rows.length > 20);
  for (const r of rows) { assert.equal(r.index % 5, 0); for (const v of Object.values(r.factors)) assert.ok(v === null || v % 5 === 0); }
});

test('an employer cannot flood demand: 3 posts and 500 openings per role in 90 days, and posts can be withdrawn', async () => {
  const employer = await as('recruiter@demo.ngrm.in'), student = await as('ananya@demo.ngrm.in');
  h.run("DELETE FROM demand_posts WHERE employer_id = 1 AND role = 'marketing'");
  const post = (openings) => employer('POST', '/api/employer/demand', { role: 'marketing', skills: ['Market research'], openings });
  assert.equal((await post(300)).status, 201);
  const over = await post(300); assert.equal(over.status, 409); assert.match(over.body.error, /past 500/);
  assert.equal((await post(100)).status, 201); assert.equal((await post(50)).status, 201);
  const fourth = await post(1); assert.equal(fourth.status, 409); assert.match(fourth.body.error, /already have 3/);
  assert.equal((await student('GET', '/api/demand/summary?role=marketing')).body.openings <= 500 * 3, true);
  const mine = (await employer('GET', '/api/demand')).body.filter((d) => d.mine && d.role === 'marketing');
  assert.equal(mine.length, 3);
  assert.equal((await student('DELETE', '/api/employer/demand/' + mine[0].id)).status, 403);
  assert.equal((await employer('DELETE', '/api/employer/demand/' + mine[0].id)).status, 200);
  assert.equal((await post(1)).status, 201, 'withdrawing frees a slot');
  assert.ok((await student('GET', '/api/demand')).body.every((d) => d.mine === false && !('employer_id' in d)));
  h.run("DELETE FROM demand_posts WHERE employer_id = 1 AND role = 'marketing'");
});

test('a student cannot flood their mentor: 10 items waiting at most', async () => {
  h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('flood@demo.ngrm.in', 'Flood Tester', 'student', 1)");
  const c = await as('flood@demo.ngrm.in'); await c('POST', '/api/me/consents', { purposes: { profile: true }, isAdult: true });
  const codes = []; for (let i = 0; i < 12; i++) codes.push((await c('POST', '/api/me/evidence', { type: 'certificate', title: 'Certificate ' + i })).status);
  assert.deepEqual(codes, [...Array(10).fill(201), 409, 409]);
});

test('weak passwords, out-of-range CGPA, unknown roles and missing pages are refused plainly', async () => {
  const student = await as('ananya@demo.ngrm.in'), employer = await as('recruiter@demo.ngrm.in');
  for (const pw of ['password123', 'Qwerty@2026!', '1234567890123', 'welcome-ngrm-1']) assert.equal((await student('POST', '/api/me/password', { password: pw })).status, 400, pw);
  for (const cgpa of [11, -1, 'abc']) assert.equal((await student('PUT', '/api/me/profile', { cgpa })).status, 400, String(cgpa));
  assert.equal((await student('GET', '/api/me/profile')).body.profile.cgpa, 7.6);
  assert.equal((await employer('GET', '/api/employer/supply?role=astronaut')).status, 400);
  const missing = await fetch(base + '/no-such-page'); assert.equal(missing.status, 404); assert.match(await missing.text(), /can’t find that page/);
  const big = await fetch(base + '/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(200000) }) });
  assert.equal(big.status, 413); assert.match((await big.json()).error, /request is too large/);
});

test('research export: no record stands alone on programme, year, role and rough CGPA', async () => {
  const rows = (await (await as('research@demo.ngrm.in'))('GET', '/api/research/export')).body.rows;
  const count = (key) => { const m = {}; for (const r of rows) m[key(r)] = (m[key(r)] || 0) + 1; return m; };
  const q = (r) => [r.programme, r.year, r.targetRole].join('|');
  assert.ok(Object.values(count(q)).every((n) => n >= 5), 'every programme/year/role group has at least 5');
  const withAcademic = count((r) => q(r) + '|' + r.factors.academic);
  for (const r of rows) if (r.factors.academic != null) assert.ok(withAcademic[q(r) + '|' + r.factors.academic] >= 5);
  const hidden = count((r) => (r.factors.academic == null ? q(r) : 'shown')); delete hidden.shown;
  assert.ok(Object.values(hidden).every((n) => n >= 5), 'withheld academic scores hide in groups of 5 or more');
  assert.ok(rows.every((r) => /^\d{4}-\d{2}$/.test(r.recordedAt)));
  assert.ok(rows.filter((r) => r.factors.academic != null).length > rows.length / 5, 'still useful: a fair share keep their academic band');
});

test('sign-up: a student confirms their email and gets an account with the password they chose', async () => {
  const c = client(), inst = h.get('SELECT id FROM institutions ORDER BY id LIMIT 1').id, pw = 'four quiet mango trains';
  assert.equal((await c('GET', '/api/auth/sign-up-options')).body.open, true);
  const base0 = { role: 'student', name: 'Meera Nair', email: 'Meera@newcollege.edu', institutionId: inst, password: pw };
  assert.equal((await c('POST', '/api/auth/sign-up', { ...base0, password: 'password123' })).status, 400);
  assert.equal((await c('POST', '/api/auth/sign-up', { ...base0, institutionId: 99999 })).status, 400);
  assert.equal((await c('POST', '/api/auth/sign-up', { ...base0, role: 'admin' })).status, 400);
  assert.equal((await c('POST', '/api/auth/sign-up', { ...base0, name: '' })).status, 400);
  const start = await c('POST', '/api/auth/sign-up', base0);
  assert.equal(start.status, 200); assert.match(start.body.devCode, /^\d{6}$/);
  assert.equal(h.get('SELECT COUNT(*) AS n FROM users WHERE email = ?', 'meera@newcollege.edu').n, 0, 'no account before the email is confirmed');
  assert.equal((await c('POST', '/api/auth/password', { email: 'meera@newcollege.edu', password: pw })).status, 400);
  assert.equal((await c('POST', '/api/auth/sign-up/verify', { email: 'meera@newcollege.edu', code: '000000' })).status, 400);
  const done = await c('POST', '/api/auth/sign-up/verify', { email: 'meera@newcollege.edu', code: start.body.devCode });
  assert.equal(done.status, 200); assert.equal(done.body.user.role, 'student');
  const me = (await c('GET', '/api/me')).body.user; assert.equal(me.hasPassword, true); assert.equal(me.institution.name.length > 0, true);
  const again = client(); assert.equal((await again('POST', '/api/auth/password', { email: 'meera@newcollege.edu', password: pw })).status, 200);
  assert.equal(h.get('SELECT COUNT(*) AS n FROM signups WHERE email = ?', 'meera@newcollege.edu').n, 0);
  // Signing up again with an email that already has an account looks the same and creates nothing.
  h.run('DELETE FROM otp_requests');
  const dup = await client()('POST', '/api/auth/sign-up', { ...base0, name: 'Someone Else', password: 'another long pass phrase' });
  assert.equal(dup.status, 200); assert.equal(h.get('SELECT COUNT(*) AS n FROM signups').n, 0);
  assert.equal(h.get('SELECT name FROM users WHERE email = ?', 'meera@newcollege.edu').name, 'Meera Nair');
  assert.equal((await client()('POST', '/api/auth/password', { email: 'meera@newcollege.edu', password: 'another long pass phrase' })).status, 400);
});

test('sign-up: staff and employers wait for an admin, and five wrong codes lock the request', async () => {
  const c = client(), admin = await as('admin@demo.ngrm.in'), pw = 'seven green window kites';
  const start = await c('POST', '/api/auth/sign-up', { role: 'employer', name: 'Ravi Menon', email: 'ravi@newfirm.example', orgName: 'Newfirm Analytics', password: pw });
  assert.equal(start.status, 200);
  const v = await c('POST', '/api/auth/sign-up/verify', { email: 'ravi@newfirm.example', code: start.body.devCode });
  assert.deepEqual(v.body, { pending: true });
  assert.equal((await c('GET', '/api/me')).body.user, null);
  assert.equal(h.get('SELECT COUNT(*) AS n FROM users WHERE email = ?', 'ravi@newfirm.example').n, 0);
  const wait = await c('POST', '/api/auth/password', { email: 'ravi@newfirm.example', password: pw });
  assert.equal(wait.status, 403); assert.match(wait.body.error, /waiting for approval/);
  assert.equal((await c('POST', '/api/auth/password', { email: 'ravi@newfirm.example', password: 'not the right password' })).status, 400);
  // Nobody else can overwrite a waiting request.
  h.run('DELETE FROM otp_requests');
  await client()('POST', '/api/auth/sign-up', { role: 'researcher', name: 'Impostor', email: 'ravi@newfirm.example', password: 'different long pass phrase' });
  assert.equal(h.get('SELECT name FROM signups WHERE email = ?', 'ravi@newfirm.example').name, 'Ravi Menon');
  assert.equal((await (await as('ananya@demo.ngrm.in'))('GET', '/api/admin/signups')).status, 403);
  const list = (await admin('GET', '/api/admin/signups')).body;
  assert.equal(list.length, 1); assert.equal(list[0].org, 'Newfirm Analytics'); assert.equal(list[0].pw_hash, undefined);
  assert.equal((await admin('POST', '/api/admin/signups/decide', { email: 'ravi@newfirm.example', approve: true })).status, 200);
  const inn = client(); assert.equal((await inn('POST', '/api/auth/password', { email: 'ravi@newfirm.example', password: pw })).status, 200);
  assert.equal((await inn('GET', '/api/me')).body.user.employer.name, 'Newfirm Analytics');
  // A declined request leaves nothing behind.
  h.run('DELETE FROM otp_requests');
  const m = await c('POST', '/api/auth/sign-up', { role: 'mentor', name: 'Fake Mentor', email: 'fake@nowhere.example', institutionId: h.get('SELECT id FROM institutions LIMIT 1').id, password: pw });
  await c('POST', '/api/auth/sign-up/verify', { email: 'fake@nowhere.example', code: m.body.devCode });
  assert.equal((await admin('POST', '/api/admin/signups/decide', { email: 'fake@nowhere.example', approve: false })).status, 200);
  assert.equal((await c('POST', '/api/auth/password', { email: 'fake@nowhere.example', password: pw })).status, 400);
  assert.equal(h.get("SELECT COUNT(*) AS n FROM users WHERE email = 'fake@nowhere.example'").n + h.get('SELECT COUNT(*) AS n FROM signups').n, 0);
  // Wrong codes lock the request.
  h.run('DELETE FROM otp_requests');
  const s = await c('POST', '/api/auth/sign-up', { role: 'researcher', name: 'Lock Test', email: 'lock@uni.example', password: pw });
  for (let i = 0; i < 5; i++) await c('POST', '/api/auth/sign-up/verify', { email: 'lock@uni.example', code: '000000' });
  const locked = await c('POST', '/api/auth/sign-up/verify', { email: 'lock@uni.example', code: s.body.devCode });
  assert.equal(locked.status, 400); assert.match(locked.body.error, /Too many wrong attempts/);
});

test('sign-up can be closed, and student sign-up can be limited to college email domains', async () => {
  const db2 = open(':memory:'); seed(db2); const inst = helpers(db2).get('SELECT id FROM institutions LIMIT 1').id;
  const call = async (opts, body) => { const s = createApp(db2, { demoMode: true, sendCode: () => {}, uploadDir: uploads, ...opts }).listen(0); await new Promise((r) => s.once('listening', r));
    const r = await fetch('http://localhost:' + s.address().port + '/api/auth/sign-up', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); s.close(); return r.status; };
  const body = { role: 'student', name: 'Test Person', email: 'a@gmail.com', institutionId: inst, password: 'nine brave paper boats' };
  assert.equal(await call({ signUp: 'off' }, body), 403);
  assert.equal(await call({ signUpDomains: 'college.edu.in' }, body), 400);
  assert.equal(await call({ signUpDomains: 'college.edu.in' }, { ...body, email: 'a@students.college.edu.in' }), 200);
});

test('default mode: email and password only, with no codes anywhere', async () => {
  const db2 = open(':memory:'); seed(db2); const h2 = helpers(db2);
  const s = createApp(db2, { demoMode: true, sendCode: () => { throw new Error('no code may be sent'); }, uploadDir: uploads }).listen(0); await new Promise((r) => s.once('listening', r));
  const b2 = 'http://localhost:' + s.address().port;
  const mk = () => { let cookie = ''; return async (method, url, body) => { const r = await fetch(b2 + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; }; };
  try {
    const c = mk(), inst = h2.get('SELECT id FROM institutions LIMIT 1').id, pw = 'four quiet mango trains';
    assert.equal((await c('GET', '/api/meta')).body.emailCodes, false);
    assert.equal((await c('POST', '/api/auth/request-code', { email: 'ananya@demo.ngrm.in' })).status, 404);
    assert.equal((await c('POST', '/api/auth/verify', { email: 'ananya@demo.ngrm.in', code: '123456' })).status, 404);
    // A student signs up and is in at once.
    const up = await c('POST', '/api/auth/sign-up', { role: 'student', name: 'Meera Nair', email: 'meera@newcollege.edu', institutionId: inst, password: pw });
    assert.equal(up.status, 200); assert.equal(up.body.user.role, 'student'); assert.equal(up.body.devCode, undefined);
    assert.equal((await c('GET', '/api/me')).body.user.email, 'meera@newcollege.edu');
    assert.equal((await mk()('POST', '/api/auth/password', { email: 'meera@newcollege.edu', password: pw })).status, 200);
    assert.equal((await mk()('POST', '/api/auth/sign-up', { role: 'student', name: 'Copy Cat', email: 'meera@newcollege.edu', institutionId: inst, password: 'another long pass phrase' })).status, 409);
    // Staff wait for the admin, and nobody can take over a waiting request.
    const staff = mk(); assert.deepEqual((await staff('POST', '/api/auth/sign-up', { role: 'mentor', name: 'Dr. New Mentor', email: 'mentor@newcollege.edu', institutionId: inst, password: pw })).body, { pending: true });
    assert.equal((await staff('GET', '/api/me')).body.user, null);
    assert.equal((await staff('POST', '/api/auth/password', { email: 'mentor@newcollege.edu', password: pw })).status, 403);
    assert.equal((await mk()('POST', '/api/auth/sign-up', { role: 'mentor', name: 'Impostor', email: 'mentor@newcollege.edu', institutionId: inst, password: 'another long pass phrase' })).status, 409);
    const admin = mk(); await admin('POST', '/api/auth/demo', { email: 'admin@demo.ngrm.in' });
    assert.equal((await admin('POST', '/api/admin/signups/decide', { email: 'mentor@newcollege.edu', approve: true })).status, 200);
    assert.equal((await staff('POST', '/api/auth/password', { email: 'mentor@newcollege.edu', password: pw })).status, 200);
    // People an admin adds get a temporary password, shown once, which they must change before doing anything else.
    const added = await admin('POST', '/api/admin/users', { rows: [{ name: 'Asha Rao', email: 'asha@newcollege.edu', role: 'student', org: h2.get('SELECT name FROM institutions WHERE id = ?', inst).name }] });
    assert.equal(added.status, 201); const temp = added.body.passwords[0].password; assert.match(temp, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    assert.ok(!JSON.stringify(h2.all('SELECT * FROM passwords')).includes(temp), 'only a hash is stored');
    const asha = mk(); const first = await asha('POST', '/api/auth/password', { email: 'asha@newcollege.edu', password: temp });
    assert.equal(first.status, 200); assert.equal(first.body.mustChange, true);
    assert.equal((await asha('GET', '/api/me')).body.user.mustChangePassword, true);
    assert.equal((await asha('POST', '/api/me/consents', { purposes: { profile: true }, isAdult: true })).status, 403);
    assert.equal((await asha('POST', '/api/me/password', { password: temp })).status, 400, 'the temporary password cannot be kept');
    assert.equal((await asha('POST', '/api/me/password', { password: 'nine brave paper boats' })).status, 200);
    assert.equal((await asha('GET', '/api/me')).body.user.mustChangePassword, false);
    assert.notEqual((await asha('POST', '/api/me/consents', { purposes: { profile: true }, isAdult: true })).status, 403);
    // Forgotten password: the admin resets it; the old one stops working and open sessions end.
    const id = h2.get("SELECT id FROM users WHERE email = 'asha@newcollege.edu'").id;
    assert.equal((await asha('POST', '/api/admin/users/' + id + '/reset-password')).status, 403);
    const reset = await admin('POST', '/api/admin/users/' + id + '/reset-password'); assert.equal(reset.status, 200);
    assert.equal((await asha('GET', '/api/me')).body.user, null);
    assert.equal((await mk()('POST', '/api/auth/password', { email: 'asha@newcollege.edu', password: 'nine brave paper boats' })).status, 400);
    assert.equal((await mk()('POST', '/api/auth/password', { email: 'asha@newcollege.edu', password: reset.body.password })).body.mustChange, true);
  } finally { s.close(); }
});

test('the first admin gets a password from ADMIN_PASSWORD and must change it', () => {
  const { bootstrap } = require('../server/seed'); const db3 = open(':memory:'), h3 = helpers(db3);
  assert.equal(bootstrap(db3, { ADMIN_EMAIL: 'Lead@ngrm.example', ADMIN_PASSWORD: 'first-start-secret' }), 'lead@ngrm.example');
  const row = h3.get('SELECT p.hash, p.must_change FROM passwords p JOIN users u ON u.id = p.user_id WHERE u.email = ?', 'lead@ngrm.example');
  assert.equal(row.must_change, 1); assert.ok(!row.hash.includes('first-start-secret'));
  // A later restart does not overwrite the password the admin chose.
  h3.run("UPDATE passwords SET hash = 'chosen', must_change = 0");
  assert.equal(bootstrap(db3, { ADMIN_EMAIL: 'lead@ngrm.example', ADMIN_PASSWORD: 'first-start-secret' }), null);
  assert.equal(h3.get('SELECT hash FROM passwords').hash, 'chosen');
});

test('confirmation: a typed CGPA and self-rated skills count only once the mentor confirms them', async () => {
  const mentor = await as('kavya@demo.ngrm.in'), ananya = await as('ananya@demo.ngrm.in');
  const id = h.get("SELECT id FROM users WHERE email = 'ananya@demo.ngrm.in'").id;
  const before = (await ananya('GET', '/api/me/profile')).body;
  // Typing a higher CGPA or perfect skills raises nothing, and the changed CGPA drops out until confirmed.
  const typed = (await ananya('PUT', '/api/me/profile', { cgpa: 9.9, skills: [100, 100, 100, 100] })).body;
  assert.equal(typed.profile.cgpaConfirmed, false); assert.equal(typed.score.factors.academic, null);
  assert.equal(typed.score.factors.technical, before.score.factors.technical);
  assert.ok(typed.score.flags.cgpaUnconfirmed);
  assert.equal((await ananya('GET', '/api/me/recommendations')).body.items[0].id, 'confirm');
  assert.equal((await ananya('POST', '/api/mentor/assessments', { studentId: id, what: 'cgpa', value: 9.9 })).status, 403);
  // The mentor sees what is waiting, and confirms the figure from college records.
  const row = (await mentor('GET', '/api/mentor/mentees')).body.find((m) => m.id === id);
  assert.equal(row.cgpaConfirmed, false); assert.equal(row.cgpa, 9.9);
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: id, what: 'cgpa', value: 11 })).status, 400);
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: id, what: 'cgpa', value: 7.6 })).status, 201);
  const after = (await ananya('GET', '/api/me/profile')).body;
  assert.equal(after.profile.cgpa, 7.6); assert.equal(after.profile.cgpaConfirmed, true); assert.equal(after.score.factors.academic, 76);
  // Each assessed skill adds to the technical factor.
  assert.equal((await mentor('POST', '/api/mentor/assessments', { studentId: id, what: '3', value: 40 })).status, 201);
  const more = (await ananya('GET', '/api/me/profile')).body;
  assert.ok(more.score.factors.technical > after.score.factors.technical); assert.equal(more.score.skillsAssessed, after.score.skillsAssessed + 1);
});

test('typed roles and programmes: anything can be typed, and the plan follows the role and the programme', async () => {
  const db2 = open(':memory:'); seed(db2); require('../server/seed').bootstrap(db2, {}); const h2 = helpers(db2);
  const s = createApp(db2, { demoMode: true, sendCode: () => {}, uploadDir: uploads }).listen(0); await new Promise((r) => s.once('listening', r));
  const b2 = 'http://localhost:' + s.address().port;
  const who = async (email) => { let cookie = ''; const c = async (method, url, body) => { const r = await fetch(b2 + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; }; if (email) await c('POST', '/api/auth/demo', { email }); return c; };
  try {
    const ananya = await who('ananya@demo.ngrm.in'), admin = await who('admin@demo.ngrm.in'), employer = await who('recruiter@demo.ngrm.in'), mentor = await who('kavya@demo.ngrm.in');
    assert.equal((await (await who())('POST', '/api/library/role', { text: 'Data Scientist' })).status, 401);
    // A typed role is matched to its kind of work and gets that kind's four skills.
    const ds = await ananya('POST', '/api/library/role', { text: '  data   scientist ' });
    assert.equal(ds.status, 201); assert.equal(ds.body.role.label, 'data scientist'); assert.equal(ds.body.role.family, 'ai');
    assert.deepEqual(ds.body.role.skills, ['Python', 'Statistics and probability', 'Machine learning basics', 'Data handling with SQL']);
    assert.equal(ds.body.role.listed, false, 'a student’s typed role is not offered to everyone until an admin lists it');
    assert.equal((await ananya('POST', '/api/library/role', { text: 'Data Scientist' })).body.created, false, 'same name, same role');
    assert.equal((await ananya('POST', '/api/library/role', { text: 'UX Researcher' })).body.key, 'ux', 'an existing role is reused');
    for (const bad of ['', 'x', '12345', 'see http://evil.example', '<script>alert(1)</script>@x']) assert.equal((await ananya('POST', '/api/library/role', { text: bad })).status, 400, bad);
    // A typed programme is matched to a discipline and a usual length.
    const prog = await ananya('POST', '/api/library/programme', { text: 'B.E. Mechanical Engineering' });
    assert.equal(prog.status, 201); assert.equal(prog.body.programme.years, 4); assert.equal(prog.body.programme.discipline, 'engineering');
    // Other students do not see it; the student who typed it and staff do.
    assert.ok(!(await (await who())('GET', '/api/meta')).body.roles[ds.body.key]);
    assert.ok((await mentor('GET', '/api/meta')).body.roles[ds.body.key]);
    // Choosing them personalises the profile and the plan.
    const saved = await ananya('PUT', '/api/me/profile', { role: ds.body.key, prog: prog.body.id, year: 4 });
    assert.equal(saved.status, 200); assert.equal(saved.body.profile.role, ds.body.key); assert.equal(saved.body.profile.year, 4);
    assert.equal(saved.body.path.fit, 'related'); assert.match(saved.body.path.text, /B\.E\. Mechanical Engineering is a workable base for data scientist/);
    assert.ok((await ananya('GET', '/api/meta')).body.roles[ds.body.key], 'her own role is in her list');
    const plan = (await ananya('GET', '/api/me/recommendations')).body;
    assert.equal(plan.path.label, 'Related path');
    const course = plan.items.find((x) => x.id === 'course'), project = plan.items.find((x) => x.id === 'project'), intern = plan.items.find((x) => x.id === 'internship');
    assert.match(course.title, /python|statistics and probability|machine learning basics|data handling with sql/);
    assert.match(course.why, /B\.E\. Mechanical Engineering touches this only lightly/);
    assert.match(project.what, /Train and evaluate a small model/); assert.match(intern.what, /data science or machine learning internship/);
    assert.equal(course.learn.skill.length > 0, true); assert.ok(course.learn.searches.length >= 1, 'live course searches work for any typed skill');
    // A switch is worded as a switch.
    await ananya('PUT', '/api/me/profile', { prog: 'ba-jour' });
    assert.equal((await ananya('GET', '/api/me/profile')).body.path.fit, 'switch');
    // The mentor assesses the typed role's own skills.
    const id = h2.get("SELECT id FROM users WHERE email = 'ananya@demo.ngrm.in'").id;
    const a = await mentor('POST', '/api/mentor/assessments', { studentId: id, what: '2', value: 66 });
    assert.equal(a.status, 201); assert.equal(a.body.label, 'Machine learning basics');
    assert.equal((await mentor('GET', '/api/mentor/mentees')).body.find((m) => m.id === id).fit, 'Career switch');
    // An employer can type a role too; theirs is listed at once and can carry a requirement.
    const ca = await employer('POST', '/api/library/role', { text: 'Chartered Accountant' });
    assert.equal(ca.body.role.family, 'finance'); assert.equal(ca.body.role.listed, true);
    assert.equal((await employer('POST', '/api/employer/demand', { role: ca.body.key, skills: ['Taxation and GST basics'], openings: 4, city: 'Mysuru' })).status, 201);
    assert.equal((await employer('GET', '/api/employer/supply?role=' + ca.body.key)).body.total.strong, null, 'no students yet, so nothing is shown');
    const se = await employer('POST', '/api/library/role', { text: 'Software Engineer' });
    const rel = (await employer('GET', '/api/employer/supply?role=' + se.body.key)).body.related;
    assert.ok(rel.some((r) => r.key === 'dev' && r.students >= 5), 'points to the nearby role students actually chose');
    // Something NGRM cannot place starts with general skills and is flagged for the admin.
    const odd = await ananya('POST', '/api/library/role', { text: 'Astronaut' });
    assert.equal(odd.body.role.needsReview, true); assert.equal(odd.body.role.family, 'general');
    // Admin tools: correct the skills, list it, and remove only when unused.
    assert.equal((await ananya('GET', '/api/admin/library')).status, 403);
    const lib = (await admin('GET', '/api/admin/library')).body;
    assert.equal(lib.roles.find((r) => r.key === ds.body.key).use.students, 1);
    assert.equal((await admin('PUT', '/api/admin/library/roles/' + odd.body.key, { skills: ['Physics', 'Physics', 'Fitness', 'Teamwork'] })).status, 400);
    const fixed = await admin('PUT', '/api/admin/library/roles/' + odd.body.key, { label: 'Astronaut', skills: ['Orbital mechanics', 'Flight systems', 'Physical fitness', 'Crew teamwork'], target: [70, 70, 80, 75], listed: true });
    assert.equal(fixed.status, 200); assert.equal(fixed.body.needsReview, false); assert.equal(fixed.body.listed, true);
    assert.ok((await (await who())('GET', '/api/meta')).body.roles[odd.body.key], 'listed roles are offered to everyone');
    assert.equal((await admin('PUT', '/api/admin/library/roles/' + ds.body.key, { skills: ['A one', 'B two', 'C three', 'D four'] })).status, 409, 'skills lock once students are assessed');
    assert.equal((await admin('PUT', '/api/admin/library/roles/' + ds.body.key, { label: 'UX Researcher' })).status, 409);
    assert.equal((await admin('DELETE', '/api/admin/library/roles/' + ds.body.key)).status, 409);
    assert.equal((await admin('DELETE', '/api/admin/library/roles/' + odd.body.key)).status, 200);
    assert.equal((await admin('DELETE', '/api/admin/library/programmes/' + prog.body.id)).status, 200);
    assert.equal((await admin('PUT', '/api/admin/library/roles/hr', { label: 'X role' })).status, 404, 'built-in roles cannot be edited here');
    // College view: a role with enough students can be picked and shows its skills; a small one is hidden.
    const college = await who('placement@demo.ngrm.in');
    const all = (await college('GET', '/api/college/cohort')).body;
    assert.ok(all.groups.roles.length >= 3 && all.groups.programmes.length >= 3);
    const one = (await college('GET', '/api/college/cohort?role=' + all.groups.roles[0].id)).body;
    assert.equal(one.suppressed, false); assert.equal(one.roleSkills.length, 4);
    assert.equal((await college('GET', '/api/college/cohort?role=' + ds.body.key)).body.suppressed, true);
    // Role ideas follow the programme.
    const ideas = (await ananya('GET', '/api/library/suggest?programme=bcom')).body;
    assert.equal(ideas.roles[0].label, 'Chartered Accountant', 'a listed role of that kind is offered first'); assert.equal(ideas.roles[0].fit, 'direct'); assert.ok(ideas.roles.some((r) => r.key === 'marketing'));
    // A student cannot flood the list.
    for (let i = 0; i < 8; i++) await ananya('POST', '/api/library/role', { text: 'Made up role number ' + String.fromCharCode(97 + i) });
    assert.equal((await ananya('POST', '/api/library/role', { text: 'One more made up role' })).status, 429);
  } finally { s.close(); }
});

test('role and programme matching is fixed and predictable', () => {
  const L = require('../server/library');
  const fam = (t) => L.familyOf(t).k, disc = (t) => (L.disciplineOf(t) || {}).k;
  assert.deepEqual(['UX Researcher', 'HR Analyst', 'Data Scientist', 'Software Engineer', 'Bank PO', 'Civil Engineer', 'IAS officer', 'Clinical Psychologist', 'High school teacher', 'Journalist', 'Zzz'].map(fam),
    ['ux', 'hr', 'ai', 'software', 'banking', 'engineering', 'civil', 'wellbeing', 'teaching', 'content', 'general']);
  assert.deepEqual(['B.A. Psychology', 'B.Sc. Computer Science', 'B.Com', 'BBA LLB', 'M.A. English', 'MBBS'].map(disc), ['psychology', 'cs', 'commerce', 'law', 'humanities', 'health']);
  assert.deepEqual(['B.Tech. Computer Science', 'MBBS', 'MBA Finance', 'B.Sc. Physics'].map(L.yearsOf), [4, 5, 2, 3]);
  assert.deepEqual([L.fit('psychology', 'hr'), L.fit('cs', 'product'), L.fit('commerce', 'ai'), L.fit('general', 'hr')], ['direct', 'related', 'switch', 'open']);
  // Every family has four skills and four sensible targets.
  for (const f of L.FAMILIES.concat([L.GENERAL])) { assert.equal(f.skills.length, 4, f.k); assert.equal(new Set(f.skills).size, 4, f.k); assert.ok(f.target.every((t) => t >= 40 && t <= 90), f.k); }
});

test('typed everywhere: own words, own steps, typed college, typed employer skills, and a personal summary', async () => {
  const db2 = open(':memory:'); seed(db2); const h2 = helpers(db2);
  const s = createApp(db2, { demoMode: true, sendCode: () => {}, uploadDir: uploads }).listen(0); await new Promise((r) => s.once('listening', r));
  const b2 = 'http://localhost:' + s.address().port;
  const who = async (email) => { let cookie = ''; const c = async (method, url, body) => { const r = await fetch(b2 + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; }; if (email) await c('POST', '/api/auth/demo', { email }); return c; };
  try {
    const ananya = await who('ananya@demo.ngrm.in'), mentor = await who('kavya@demo.ngrm.in'), employer = await who('recruiter@demo.ngrm.in'), admin = await who('admin@demo.ngrm.in');
    const before = (await ananya('GET', '/api/me/profile')).body.score.index;
    // In her own words: kept, cleaned, and never part of the score.
    const saved = (await ananya('PUT', '/api/me/profile', { goal: '  I want to teach   children ', interests: 'writing, <b>cricket</b>', cities: 'Mysuru, Bengaluru',
      ownSkills: [{ name: 'Tally', level: 70 }, { name: 'tally', level: 10 }, { name: 'x' }, { name: 'Spoken Kannada', level: 400 }] })).body;
    assert.equal(saved.mine.goal, 'I want to teach children'); assert.ok(!/[<>]/.test(saved.mine.interests));
    assert.deepEqual(saved.mine.ownSkills, [{ name: 'Tally', level: 70 }, { name: 'Spoken Kannada', level: 100 }]);
    assert.equal(saved.score.index, before, 'typed details never change the score');
    assert.ok(saved.interestRoles.some((r) => r.label === 'Teacher'), JSON.stringify(saved.interestRoles));
    assert.equal((await ananya('PUT', '/api/me/profile', { clarity: 60 })).body.mine.goal, 'I want to teach children', 'left alone when not sent');
    // Steps of her own.
    assert.equal((await ananya('POST', '/api/me/steps', { title: '' })).status, 400);
    const st = (await ananya('POST', '/api/me/steps', { title: 'Finish my portfolio website', slot: 'winter' })).body.own;
    assert.equal(st.length, 1); assert.equal(st[0].slot, 'winter');
    assert.equal((await ananya('PATCH', '/api/me/steps/' + st[0].id, { done: true })).body.own[0].done, true);
    assert.equal((await mentor('PATCH', '/api/me/steps/' + st[0].id, { done: false })).status, 403);
    assert.equal((await ananya('GET', '/api/me/recommendations')).body.own.length, 1);
    assert.equal((await ananya('GET', '/api/me/profile')).body.score.index, (await ananya('GET', '/api/me/profile')).body.score.index);
    // The mentor sees it all in the student's words.
    const id = h2.get("SELECT id FROM users WHERE email = 'ananya@demo.ngrm.in'").id;
    const w = (await mentor('GET', '/api/mentor/mentees')).body.find((m) => m.id === id).inWords;
    assert.equal(w.goal, 'I want to teach children'); assert.equal(w.steps[0].title, 'Finish my portfolio website'); assert.equal(w.ownSkills.length, 2);
    // An employer types what else they need; the student is told what matches her.
    assert.equal((await employer('POST', '/api/employer/demand', { role: 'hr', skills: [], extraSkills: '', openings: 2 })).status, 400);
    assert.equal((await employer('POST', '/api/employer/demand', { role: 'hr', skills: [], extraSkills: 'Tally, spoken kannada, <i>x</i>, Night shifts', openings: 6, city: 'Mysuru' })).status, 201);
    const sum = (await ananya('GET', '/api/demand/summary?role=hr')).body;
    assert.equal(sum.personal.openingsInMyCities >= 6, true);
    assert.deepEqual(sum.personal.alsoAsked.filter((k) => k.have).map((k) => k.name).sort(), ['Tally', 'spoken kannada']);
    assert.equal((await employer('GET', '/api/demand/summary?role=hr')).body.personal, null);
    // Sign-up with a college typed in.
    const guest = await who();
    const up = await guest('POST', '/api/auth/sign-up', { role: 'student', name: 'Irfan Khan', email: 'irfan@newcollege.example', institutionName: 'New Horizon Arts College', institutionCity: 'Hubballi', password: 'small river stone path' });
    assert.equal(up.status, 200);
    const col = h2.get("SELECT * FROM institutions WHERE name = 'New Horizon Arts College'"); assert.equal(col.pending, 1); assert.equal(col.city, 'Hubballi');
    assert.ok(!(await guest('GET', '/api/auth/sign-up-options')).body.institutions.some((i) => i.id === col.id), 'not offered to others until confirmed');
    assert.equal((await (await who())('POST', '/api/auth/sign-up', { role: 'student', name: 'Second Student', email: 'second@newcollege.example', institutionName: 'new horizon arts college', password: 'small river stone path' })).status, 200);
    assert.equal(h2.get("SELECT COUNT(*) AS n FROM institutions WHERE lower(name) = 'new horizon arts college'").n, 1, 'the same typed name is the same college');
    assert.equal((await (await who())('POST', '/api/auth/sign-up', { role: 'student', name: 'No College', email: 'none@x.example', password: 'small river stone path' })).status, 400);
    assert.equal((await (await who())('POST', '/api/auth/sign-up', { role: 'student', name: 'Weak', email: 'weak@x.example', institutionName: 'Should Not Be Created College', password: 'password123' })).status, 400);
    assert.equal(h2.get("SELECT COUNT(*) AS n FROM institutions WHERE name LIKE 'Should Not%'").n, 0, 'a failed sign-up adds no college');
    assert.equal((await ananya('POST', '/api/admin/orgs/' + col.id + '/confirm', {})).status, 403);
    assert.equal((await admin('POST', '/api/admin/orgs/' + col.id + '/confirm', { city: 'Hubballi-Dharwad' })).status, 200);
    assert.ok((await guest('GET', '/api/auth/sign-up-options')).body.institutions.some((i) => i.id === col.id && i.city === 'Hubballi-Dharwad'));
    // A personal summary for each kind of account.
    const today = async (c) => (await c('GET', '/api/me/today')).body;
    const a = await today(ananya); assert.equal(a.first, 'Ananya'); assert.match(a.lines.join(' '), /aiming for HR \/ People Analytics Associate/);
    const m = await today(mentor); assert.equal(m.first, 'Kavya'); assert.match(m.lines.join(' '), /You mentor \d+ students/);
    assert.match((await today(employer)).lines.join(' '), /requirement/); assert.match((await today(admin)).lines.join(' '), /Waiting for you|Nothing is waiting/);
    assert.match((await today(await who('placement@demo.ngrm.in'))).lines.join(' '), /students on NGRM/); assert.match((await today(await who('research@demo.ngrm.in'))).lines.join(' '), /baseline/);
    assert.equal((await (await who())('GET', '/api/me/today')).status, 401);
  } finally { s.close(); }
});

test('every student gets a mentor, and impossible dates are refused', async () => {
  const db2 = open(':memory:'); seed(db2); const h2 = helpers(db2);
  const s = createApp(db2, { demoMode: true, sendCode: () => {}, uploadDir: uploads }).listen(0); await new Promise((r) => s.once('listening', r));
  const b2 = 'http://localhost:' + s.address().port;
  const who = async (email) => { let cookie = ''; const c = async (method, url, body) => { const r = await fetch(b2 + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; let json = null; try { json = await r.json(); } catch {} return { status: r.status, body: json }; }; if (email) await c('POST', '/api/auth/demo', { email }); return c; };
  try {
    assert.equal(h2.get("SELECT COUNT(*) AS n FROM users u WHERE u.role = 'student' AND NOT EXISTS (SELECT 1 FROM mentor_links l WHERE l.student_id = u.id)").n, 0, 'no sample student is left without a mentor');
    // A new sign-up is given the mentor at their college with the fewest students.
    const inst = h2.get("SELECT institution_id AS i FROM users WHERE email = 'kavya@demo.ngrm.in'").i;
    const meera = await who(); assert.equal((await meera('POST', '/api/auth/sign-up', { role: 'student', name: 'Meera Nair', email: 'meera@x.example', institutionId: inst, password: 'four quiet mango trains' })).status, 200);
    const id = h2.get("SELECT id FROM users WHERE email = 'meera@x.example'").id;
    const link = h2.get('SELECT mentor_id FROM mentor_links WHERE student_id = ?', id); assert.ok(link, 'given a mentor at sign-up');
    assert.equal(h2.get('SELECT institution_id AS i FROM users WHERE id = ?', link.mentor_id).i, inst);
    // At a college with no mentor yet, students wait; the placement cell sees the count and shares them out once a mentor exists.
    const col = Number(h2.run("INSERT INTO institutions (name, city, is_sample) VALUES ('Mentorless College', 'Tumakuru', 0)").lastInsertRowid);
    for (const n of [1, 2, 3]) await (await who())('POST', '/api/auth/sign-up', { role: 'student', name: 'Student ' + 'abc'[n - 1], email: `s${n}@ml.example`, institutionId: col, password: 'four quiet mango trains' });
    h2.run("INSERT INTO users (email, name, role, institution_id, is_sample) VALUES ('cell@ml.example', 'Placement Cell', 'college_admin', ?, 0)", col);
    const cell = await who(); await cell('POST', '/api/auth/demo', { email: 'cell@ml.example' }).catch(() => {});
    const admin = await who('admin@demo.ngrm.in');
    // (the demo sign-in only covers the listed demo accounts, so sign the cell in with a password the admin hands over)
    const temp = (await admin('POST', '/api/admin/users/' + h2.get("SELECT id FROM users WHERE email = 'cell@ml.example'").id + '/reset-password')).body.password;
    await cell('POST', '/api/auth/password', { email: 'cell@ml.example', password: temp }); await cell('POST', '/api/me/password', { password: 'nine brave paper boats' });
    let m = (await cell('GET', '/api/college/mentoring')).body; assert.equal(m.withoutMentor, 3); assert.equal(m.mentors.length, 0);
    assert.equal((await cell('POST', '/api/college/mentoring/share')).status, 409);
    assert.equal((await meera('GET', '/api/college/mentoring')).status, 403);
    // The admin adds two mentors: waiting students are shared among them at once.
    assert.equal((await admin('POST', '/api/admin/users', { rows: [{ name: 'Mentor One', email: 'm1@ml.example', role: 'mentor', org: 'Mentorless College' }, { name: 'Mentor Two', email: 'm2@ml.example', role: 'mentor', org: 'Mentorless College' }] })).status, 201);
    m = (await cell('GET', '/api/college/mentoring')).body; assert.equal(m.withoutMentor, 0); assert.deepEqual(m.mentors.map((x) => x.students).sort(), [1, 2]);
    assert.ok(!JSON.stringify(m).includes('Student a'), 'the placement cell sees counts, not student names');
    // Dates that cannot be right are refused.
    await meera('POST', '/api/me/consents', { purposes: { profile: true }, isAdult: true });
    for (const bad of ['2031-01-01', '1900-01-01', '2026-13-45', '2026-02-30', 'yesterday']) assert.equal((await meera('POST', '/api/me/evidence', { type: 'project', title: 'A project', completedOn: bad })).status, 400, bad);
    assert.equal((await meera('POST', '/api/me/evidence', { type: 'project', title: 'A project', completedOn: '2026-10-05' })).status, 201);
  } finally { s.close(); }
});
