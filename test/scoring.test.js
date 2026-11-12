const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/domain');
const { isSafeRewrite } = require('../server/ai');

const V = (type, n = 1) => Array(n).fill({ type, status: 'verified' });

test('sample student matches the hand-worked score (45.8) under formula v0.2', () => {
  const p = { prog: 'ba-psy', year: 2, cgpa: 7.6, role: 'hr', skills: [55, 72, 60, 45], ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, comm: null, clarity: 55 };
  const r = D.score(p, [...V('course'), ...V('project'), ...V('assessment')]);
  assert.equal(r.version, 'v0.2');
  assert.deepEqual(r.factors, { academic: 76, technical: 59.5, projects: 35, experience: 0, psychometric: 61.4, communication: null, leadership: 0, clarity: 55 });
  // (76×20 + 59.5×20 + 35×15 + 0×15 + 61.4×10 + 0×5 + 55×5) ÷ 90 rated weight = 4124 ÷ 90 = 45.82
  assert.equal(r.index, 45.8);
  assert.equal(r.completeness, 90);
  assert.deepEqual(r.notRated, ['communication']);
});

test('a blank never beats an honest answer: unanswered factors are left out, not given a default', () => {
  const full = { cgpa: 7.6, skills: [55, 72, 60, 45], ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, comm: 61, clarity: 55 };
  const r = D.score({ cgpa: null, skills: [50, 50, 50, 50], ocean: null, comm: null, clarity: null }, []);
  assert.deepEqual(r.notRated, ['academic', 'psychometric', 'communication', 'clarity']);
  assert.equal(r.factors.academic, null); assert.equal(r.flags.cgpaMissing, true);
  assert.equal(r.completeness, 55);
  // technical 50×20 + projects, experience, leadership at 0 → 1000 ÷ 55
  assert.equal(r.index, 18.2);
  // No factor ever gets a value the student did not earn or enter.
  for (const blank of ['ocean', 'comm', 'clarity']) {
    const without = D.score({ ...full, [blank]: null }, []);
    assert.equal(without.factors[{ ocean: 'psychometric', comm: 'communication', clarity: 'clarity' }[blank]], null);
  }
});

test('only verified evidence counts, starting from zero, with caps at 100', () => {
  const base = { cgpa: 8, skills: [90, 90, 90, 90], ocean: null, comm: 80, clarity: 80 };
  const none = D.score(base, [{ type: 'internship', status: 'pending' }, { type: 'project', status: 'needs_proof' }, { type: 'role' }]);
  assert.deepEqual([none.factors.projects, none.factors.experience, none.factors.leadership], [0, 0, 0]);
  const one = D.score(base, [...V('project'), ...V('internship'), ...V('role')]);
  assert.deepEqual([one.factors.projects, one.factors.experience, one.factors.leadership], [35, 50, 50]);
  const many = D.score(base, [...V('project', 5), ...V('internship', 3), ...V('role', 4), ...V('certificate', 4)]);
  assert.deepEqual([many.factors.projects, many.factors.experience, many.factors.leadership, many.factors.technical], [100, 100, 100, 100]);
  // Made-up, unverified items change nothing.
  const fake = D.score(base, Array(8).fill({ type: 'internship', status: 'pending' }).concat(Array(6).fill({ type: 'role', status: 'pending' })));
  assert.equal(fake.index, none.index);
});

test('bands are reachable at both ends', () => {
  const weak = D.score({ cgpa: 5.5, skills: [35, 40, 30, 45], ocean: null, comm: null, clarity: 40 }, []);
  const strong = D.score({ cgpa: 8.8, skills: [85, 80, 90, 78], ocean: { o: 70, c: 80, e: 60, a: 75, n: 30 }, comm: 82, clarity: 85 }, [...V('project', 3), ...V('internship', 2), ...V('role', 2), ...V('course', 2)]);
  assert.equal(D.band(weak.index).k, 'building');
  assert.equal(D.band(strong.index).k, 'ready');
});

test('recommendations are ranked by real score gain and never invent numbers', () => {
  const p = { role: 'hr', cgpa: 7.6, skills: [55, 72, 60, 45], ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, comm: null, clarity: 55 };
  const ev = [...V('course'), ...V('project')];
  const settings = D.DEFAULT_RULE_SETTINGS.map((s) => ({ ...s, active: 1 }));
  const list = D.recommend(p, ev, settings).filter((x) => !x.always);
  assert.ok(list.length > 0 && list.length <= 5);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].gain >= list[i].gain);
  assert.equal(list[0].id, 'internship');
  // One verified internship: experience 0 → 50, weight 15 of 90 rated: 45.8 → 54.2
  assert.equal(list[0].gain, 8.4);
});

test('inactive rules are never recommended', () => {
  const p = { role: 'hr', cgpa: 6, skills: [40, 40, 40, 40], ocean: null, comm: null, clarity: 30 };
  const settings = D.DEFAULT_RULE_SETTINGS.map((s) => ({ ...s, active: s.id === 'internship' ? 0 : 1 }));
  assert.ok(!D.recommend(p, [], settings).some((x) => x.id === 'internship'));
});

test('AI rewrites are rejected if they add numbers or links', () => {
  const src = 'Experience carries 15% of your score. You have no internships yet, so this factor sits at 70.';
  assert.equal(isSafeRewrite(src, 'An internship would help: experience is 15% of your score and you are at 70 for now.'), true);
  assert.equal(isSafeRewrite(src, 'An internship adds 25 points and 90% of students get jobs.'), false);
  assert.equal(isSafeRewrite(src, 'See https://example.com for internships worth 15% of your score.'), false);
});

test('a clarity rating of 0 counts as 0; a missing one is left out', () => {
  const p = { cgpa: 8, skills: [60, 60, 60, 60], ocean: null, comm: 70, clarity: 0 };
  assert.equal(D.score(p, []).factors.clarity, 0);
  assert.equal(D.score({ ...p, clarity: null }, []).factors.clarity, null);
});

test('the counsellor referral is always included, even for a strong profile', () => {
  const p = { role: 'hr', cgpa: 9.5, skills: [95, 95, 95, 95], ocean: null, comm: 95, clarity: 95 };
  const list = D.recommend(p, [], D.DEFAULT_RULE_SETTINGS.map((s) => ({ ...s, active: 1 })));
  assert.ok(list.some((x) => x.id === 'counsellor'));
});
