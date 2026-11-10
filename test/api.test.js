const test = require('node:test');
const assert = require('node:assert/strict');
const { open, helpers } = require('../server/db');
const { seed } = require('../server/seed');
const { createApp } = require('../server/app');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ngrm-up-'));

let server, base, h;
test.before(async () => {
  process.env.DEV_SHOW_OTP = 'true';
  const db = open(':memory:'); seed(db); h = helpers(db);
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
  assert.equal(put.body.score.factors.psychometric, 75);
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
  assert.equal(row.formula_version, 'v0.1');
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
  assert.equal(r.body.score.index, 68.3);
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

test('evidence a mentor sends back stops counting until the student adds proof', async () => {
  const student = await as('ananya@demo.ngrm.in'), mentor = await as('kavya@demo.ngrm.in');
  const list = (await student('POST', '/api/me/evidence', { type: 'internship', title: 'Summer HR internship' })).body;
  const id = list[list.length - 1].id;
  const withIt = (await student('GET', '/api/me/profile')).body.score.counts.internship;
  assert.equal((await mentor('POST', '/api/mentor/evidence/' + id, { action: 'needs_proof' })).status, 200);
  assert.equal((await student('GET', '/api/me/profile')).body.score.counts.internship, withIt - 1);
  assert.equal((await student('PATCH', '/api/me/evidence/' + id, { fileName: '' })).status, 400);
  const back = await student('PATCH', '/api/me/evidence/' + id, { fileName: 'offer-letter.pdf' });
  assert.equal(back.body.find((e) => e.id === id).status, 'pending');
  assert.equal((await student('GET', '/api/me/profile')).body.score.counts.internship, withIt);
  await student('DELETE', '/api/me/evidence/' + id);
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
  assert.equal(all.n, sum, 'the all-programmes total equals the visible programmes, so nothing can be subtracted');
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
  assert.equal(r.body.profile.ocean, null); assert.equal(r.body.score.factors.psychometric, 75); assert.equal(r.body.score.factors.communication, 72);
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
    const r = spawnSync(process.execPath, ['--no-warnings', 'server/index.js'], { env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: secret, DEMO_MODE: 'false', DEV_SHOW_OTP: 'false', DB_FILE: ':memory:', PORT: '0' }, timeout: 5000, encoding: 'utf8' });
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
