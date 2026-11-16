const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/domain');
const { isSafeRewrite } = require('../server/ai');

const V = (type, n = 1) => Array(n).fill({ type, status: 'verified' });

const ALL = [true, true, true, true];
const TV_NONE = [false, false, false, false, false];
const RULES_ON = D.DEFAULT_RULE_SETTINGS.map((s) => ({ ...s, active: 1 }));

test('sample student matches the hand-worked score (39.7) under formula v0.4', () => {
  const p = { prog: 'ba-psy', year: 2, cgpa: 7.6, cgpaConfirmed: true, role: 'hr', skills: [55, 72, 60, 45], skillsVerified: [false, true, false, false],
    transversal: [65, 50, 60, 55, 70], transversalVerified: TV_NONE, ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, clarity: 55 };
  const r = D.score(p, [...V('course'), ...V('project'), ...V('assessment'), { type: 'role', status: 'pending' }]);
  assert.equal(r.version, 'v0.4');
  // Technical: 72 assessed in full, 55, 60 and 45 self-rated at half → (27.5 + 72 + 30 + 22.5) ÷ 4 = 38, plus 1.5 for the course.
  // Transversal: all five self-rated, at half → 60 ÷ 2 = 30. Social-emotional: (68 + (100 − 55)) ÷ 2 = 56.5. Co-curricular: one waiting → 25.
  assert.deepEqual(r.factors, { cgpa: 76, internships: 0, projects: 35, technical: 39.5, transversal: 30, socioemotional: 56.5, cocurricular: 25, clarity: 55 });
  // (76×15 + 0×10 + 35×10 + 39.5×20 + 30×20 + 56.5×10 + 25×10 + 55×5) ÷ 100 = 3970 ÷ 100
  assert.equal(r.index, 39.7);
  // Counting only what is confirmed: technical 18 + 1.5, transversal 0, co-curricular 0 → 2720 ÷ 100
  assert.equal(r.confirmedIndex, 27.2);
  assert.equal(r.groups.academic, 42.6); // (76×15 + 0×10 + 35×10) ÷ 35
  assert.equal(r.completeness, 100);
  assert.deepEqual(D.FACTORS.map((F) => F.w), [15, 10, 10, 20, 20, 10, 10, 5]);
});

test('a blank never beats an honest answer: unanswered factors are left out, not given a default', () => {
  const r = D.score({ cgpa: null, skills: [50, 50, 50, 50], skillsVerified: ALL, ocean: null, clarity: null }, []);
  assert.deepEqual(r.notRated, ['cgpa', 'transversal', 'socioemotional', 'clarity']);
  assert.equal(r.flags.cgpaMissing, true);
  assert.equal(r.completeness, 50);
  // technical 50×20, with internships, projects and co-curricular at 0 → 1000 ÷ 50
  assert.equal(r.index, 20);
  assert.equal(D.score({ cgpa: null, skills: [50, 50, 50, 50], skillsVerified: ALL, ocean: { o: 50, c: 50, e: 50, a: 50 }, clarity: null }, []).factors.socioemotional, null);
});

test('unchecked evidence counts at half and can add at most half a factor; proof requested counts nothing', () => {
  const base = { cgpa: 8, cgpaConfirmed: true, skills: [90, 90, 90, 90], skillsVerified: ALL, ocean: null, clarity: 80 };
  const none = D.score(base, [{ type: 'internship', status: 'pending' }, { type: 'project', status: 'needs_proof' }, { type: 'role' }]);
  assert.deepEqual([none.factors.internships, none.factors.projects, none.factors.cocurricular], [25, 0, 0]);
  const one = D.score(base, [...V('project'), ...V('internship'), ...V('role')]);
  assert.deepEqual([one.factors.projects, one.factors.internships, one.factors.cocurricular], [35, 50, 50]);
  const many = D.score(base, [...V('project', 5), ...V('internship', 3), ...V('role', 4), ...V('certificate', 4)]);
  assert.deepEqual([many.factors.projects, many.factors.internships, many.factors.cocurricular, many.factors.technical], [100, 100, 100, 100]);
  // Piling up unchecked claims stops at half the factor.
  const fake = D.score(base, Array(8).fill({ type: 'internship', status: 'pending' }).concat(Array(6).fill({ type: 'role', status: 'pending' }), Array(9).fill({ type: 'certificate', status: 'pending' })));
  assert.deepEqual([fake.factors.internships, fake.factors.cocurricular, fake.factors.technical], [50, 50, 100]);
  assert.equal(fake.confirmedIndex, D.score(base, []).confirmedIndex);
});

test('bands are reachable at both ends', () => {
  const weak = D.score({ cgpa: 5.5, skills: [35, 40, 30, 45], ocean: null, clarity: 40 }, []);
  assert.equal(weak.index, 14.1); // (27.5×15 + 18.75×20 + 40×5) ÷ 70
  const strong = D.score({ cgpa: 8.8, cgpaConfirmed: true, skills: [85, 80, 90, 78], skillsVerified: ALL, transversal: [80, 75, 85, 80, 82], transversalVerified: [true, true, true, true, true], ocean: { o: 70, c: 80, e: 60, a: 75, n: 30 }, clarity: 85 },
    [...V('project', 3), ...V('internship', 2), ...V('role', 2), ...V('course', 2)]);
  assert.equal(strong.index, 88.3);
  assert.equal(D.band(weak.index).k, 'building');
  assert.equal(D.band(strong.index).k, 'ready');
});

test('the Mini-IPIP is scored as published: four items a trait, reverse-keyed items flipped', () => {
  assert.equal(D.IPIP.length, 20);
  assert.deepEqual(D.IPIP.filter((x) => x.r).map((x) => D.IPIP.indexOf(x) + 1), [6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20]);
  for (const k of ['o', 'c', 'e', 'a', 'n']) assert.equal(D.IPIP.filter((x) => x.k === k).length, 4);
  // All "very accurate": a trait with two reversed items lands in the middle; openness has three reversed → low.
  const t = D.ipipTraits(Array(20).fill(5));
  assert.deepEqual(t, { e: 50, a: 50, c: 50, n: 50, o: 25 });
  // Maximum conscientiousness, minimum neuroticism.
  const a = Array(20).fill(3); [3, 13].forEach((i) => { a[i - 1] = 5; }); [8, 18].forEach((i) => { a[i - 1] = 1; }); [4, 14].forEach((i) => { a[i - 1] = 1; }); [9, 19].forEach((i) => { a[i - 1] = 5; });
  const u = D.ipipTraits(a); assert.equal(u.c, 100); assert.equal(u.n, 0);
  assert.equal(D.score({ skills: [], ocean: u }, []).factors.socioemotional, 100);
  assert.equal(D.ipipTraits(Array(19).fill(3)), null);
  assert.equal(D.ipipTraits(Array(20).fill(3).map((x, i) => (i === 4 ? 6 : x))), null);
});

test('recommendations are ranked by real score gain and never invent numbers', () => {
  const p = { role: 'hr', cgpa: 7.6, cgpaConfirmed: true, skills: [55, 72, 60, 45], skillsVerified: [false, true, false, false], transversal: [65, 50, 60, 55, 70], transversalVerified: TV_NONE, ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, clarity: 55 };
  const ev = [...V('course'), ...V('project')];
  const list = D.recommend(p, ev, RULES_ON).filter((x) => !x.always && !x.personal);
  assert.ok(list.length > 0 && list.length <= 6);
  for (let i = 1; i < list.length; i++) if (list[i].id !== 'course') assert.ok(list[i - 1].gain >= list[i].gain);
  assert.equal(list[0].id, 'internship');
  // One verified internship: internships 0 → 50, weight 10 of 100 → +5.0
  assert.equal(list[0].gain, 5);
});
test('AI rewrites are rejected if they add numbers or links', () => {
  const src = 'Experience carries 15% of your score. You have no internships yet, so this factor sits at 70.';
  assert.equal(isSafeRewrite(src, 'An internship would help: experience is 15% of your score and you are at 70 for now.'), true);
  assert.equal(isSafeRewrite(src, 'An internship adds 25 points and 90% of students get jobs.'), false);
  assert.equal(isSafeRewrite(src, 'See https://example.com for internships worth 15% of your score.'), false);
});

test('a clarity rating of 0 counts as 0; a missing one is left out', () => {
  const p = { cgpa: 8, skills: [60, 60, 60, 60], ocean: null, clarity: 0 };
  assert.equal(D.score(p, []).factors.clarity, 0);
  assert.equal(D.score({ ...p, clarity: null }, []).factors.clarity, null);
});

test('the counsellor referral is always included, even for a strong profile', () => {
  const p = { role: 'hr', cgpa: 9.5, skills: [95, 95, 95, 95], ocean: null, clarity: 95 };
  const list = D.recommend(p, [], D.DEFAULT_RULE_SETTINGS.map((s) => ({ ...s, active: 1 })));
  assert.ok(list.some((x) => x.id === 'counsellor'));
});

test('what a student reports about themselves counts at half straight away, and in full once confirmed', () => {
  const typed = { role: 'hr', cgpa: 7.6, cgpaConfirmed: false, skills: [55, 72, 60, 45], skillsVerified: [false, false, false, false], transversal: [60, null, null, null, null], transversalVerified: TV_NONE, ocean: null, clarity: 55 };
  const r = D.score(typed, []);
  assert.equal(r.factors.cgpa, 38); assert.equal(r.factors.technical, 29); assert.equal(r.factors.transversal, 6);
  assert.deepEqual(r.notRated, ['socioemotional']);
  assert.equal(r.flags.cgpaUnconfirmed, true); assert.equal(r.flags.skillsUnassessed, 4); assert.equal(r.flags.transversalUnassessed, 1);
  // Nothing has been confirmed, so the confirmed-only score has no CGPA, skills or transversal points.
  assert.ok(r.confirmedIndex < r.index);
  // Claiming perfect marks and skills raises the score by half of what confirmation would.
  const brag = D.score({ ...typed, cgpa: 10, skills: [100, 100, 100, 100] }, []);
  assert.equal(brag.factors.cgpa, 50); assert.equal(brag.factors.technical, 50);
  // Confirmation is what turns half into full.
  const confirmed = D.score({ ...typed, cgpaConfirmed: true, skillsVerified: [true, true, false, false] }, []);
  assert.equal(confirmed.factors.cgpa, 76); assert.equal(confirmed.factors.technical, 44.9); assert.equal(confirmed.skillsAssessed, 2);
  // The plan puts confirmation first, projects no gain for it, and tells the student not to wait.
  const list = D.recommend(typed, [], RULES_ON);
  assert.equal(list[0].id, 'confirm'); assert.equal(list[0].gain, 0); assert.match(list[0].title, /CGPA and ratings confirmed/); assert.match(list[0].what, /do not need to wait/);
  assert.ok(!D.recommend({ ...typed, cgpaConfirmed: true, skillsVerified: ALL, transversal: [null, null, null, null, null] }, [], RULES_ON).some((x) => x.id === 'confirm'));
});

test('the transversal step works on the weakest of the five skills; the questionnaire step appears until it is answered', () => {
  const p = { role: 'hr', prog: 'ba-psy', year: 1, cgpa: 8, cgpaConfirmed: true, skills: [70, 70, 70, 70], skillsVerified: ALL, transversal: [70, 40, null, 65, 60], transversalVerified: TV_NONE, ocean: null, clarity: 80 };
  const list = D.recommend(p, [], RULES_ON);
  const t = list.find((x) => x.id === 'transversal');
  assert.equal(t.title, 'Build your creativity'); // not rated counts as 0, the lowest
  assert.ok(list.some((x) => x.id === 'questionnaire' && x.gain === 0 && x.personal));
  assert.ok(!D.recommend(p, [], RULES_ON, { psyConsent: false }).some((x) => x.id === 'questionnaire'));
  assert.ok(!D.recommend({ ...p, ocean: { o: 50, c: 50, e: 50, a: 50, n: 50 } }, [], RULES_ON).some((x) => x.id === 'questionnaire'));
});

test('Class 12 marks stand in for a missing CGPA on the same terms, and never once a CGPA exists', () => {
  const base = { skills: [50, 50, 50, 50], skillsVerified: ALL, ocean: null, clarity: null };
  assert.equal(D.score({ ...base, cgpa: null, class12: 82 }, []).factors.cgpa, 41);
  assert.equal(D.score({ ...base, cgpa: null, class12: 82, class12Confirmed: true }, []).factors.cgpa, 82);
  const both = D.score({ ...base, cgpa: 6, cgpaConfirmed: true, class12: 95, class12Confirmed: true }, []);
  assert.equal(both.factors.cgpa, 60); assert.equal(both.flags.marksFrom, 'cgpa');
  assert.ok(D.score({ ...base, cgpa: null, class12: null }, []).flags.cgpaMissing);
});
