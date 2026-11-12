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
  server = createApp(db, { demoMode: true, sendCode: () => {}, uploadDir: uploads }).listen(0);
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
  const other = h.get("SELECT u.id FROM users u WHERE u.role = 'student' AND u.id NOT IN (SELECT student_id FROM mentor_links) LIMIT 1").id;
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
  assert.equal(row.formula_version, 'v0.2');
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
  assert.equal(r.body.score.index, 45.8);
});

test('out-of-range and junk profile values are cleaned, and a clarity of 0 counts as 0', async () => {
  const student = await as('ananya@demo.ngrm.in');
  const r = await student('PUT', '/api/me/profile', { prog: 'nope', year: 9, cgpa: 50, role: 'astronaut', skills: ['x', -5, 200, '70'], comm: 'abc', clarity: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.profile.prog, 'ba-psy'); assert.equal(r.body.profile.year, 3); assert.equal(r.body.profile.cgpa, 10); assert.equal(r.body.profile.role, 'hr');
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
  assert.equal(h2.get('SELECT COUNT(*) AS n FROM rules').n, 8);
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
  await c('GET', '/api/me/profile');
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
  const s2 = createApp(db2, { demoMode: true, sendCode: () => {} }).listen(0); await new Promise((r) => s2.once('listening', r));
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
  assert.equal((await employer('GET', '/api/employer/supply?role=constructor')).body.role, 'hr');
  assert.equal((await student('POST', '/api/me/consents', { purposes: { constructor: true } })).status, 400);
  assert.equal((await student('POST', '/api/me/evidence', { type: 'constructor', title: 'x' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/users', { rows: [null] })).status, 400);
});

test('questionnaire answers are never invented: partial or missing traits store nothing', async () => {
  h.run("INSERT INTO users (email, name, role, institution_id) VALUES ('fresh@demo.ngrm.in', 'Fresh Student', 'student', 1)");
  const c = await as('fresh@demo.ngrm.in');
  await c('POST', '/api/me/consents', { purposes: { profile: true, psychometric: true }, isAdult: true });
  await c('GET', '/api/me/profile');
  let r = await c('PUT', '/api/me/profile', { cgpa: 8 });
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
