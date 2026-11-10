const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../server/domain');
const { isSafeRewrite } = require('../server/ai');

test('sample student matches the hand-worked score (68.3)', () => {
  const p = { prog: 'ba-psy', year: 2, cgpa: 7.6, role: 'hr', skills: [55, 72, 60, 45], ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, comm: null, clarity: 55 };
  const r = D.score(p, [{ type: 'course' }, { type: 'project' }, { type: 'assessment' }]);
  assert.deepEqual(r.factors, { academic: 76, technical: 59.5, projects: 80, experience: 70, psychometric: 61.4, communication: 61, leadership: 75, clarity: 55 });
  // 15.2 + 11.9 + 12 + 10.5 + 6.14 + 6.1 + 3.75 + 2.75 = 68.34
  assert.equal(r.index, 68.3);
  assert.equal(r.flags.commEstimated, true);
});

test('defaults: no skills 70, no questionnaire 75, no communication 72, no clarity 80, missing CGPA flagged', () => {
  const r = D.score({ cgpa: null, skills: [], ocean: null, comm: null, clarity: null }, []);
  assert.equal(r.factors.academic, 0);
  assert.equal(r.flags.cgpaMissing, true);
  assert.equal(r.factors.technical, 70);
  assert.equal(r.factors.psychometric, 75);
  assert.equal(r.factors.communication, 72);
  assert.equal(r.factors.clarity, 80);
  assert.ok(Math.abs(r.index - 57.45) < 0.051);
});

test('evidence counts move the right factors, with caps at 100', () => {
  const base = { cgpa: 8, skills: [90, 90, 90, 90], ocean: null, comm: 80, clarity: 80 };
  const ev = [].concat(Array(5).fill({ type: 'project' }), Array(3).fill({ type: 'internship' }), [{ type: 'role' }], Array(4).fill({ type: 'certificate' }));
  const r = D.score(base, ev);
  assert.equal(r.factors.projects, 100);
  assert.equal(r.factors.experience, 100);
  assert.equal(r.factors.leadership, 95);
  assert.equal(r.factors.technical, 100);
});

test('recommendations are ranked by real score gain and never invent numbers', () => {
  const p = { role: 'hr', cgpa: 7.6, skills: [55, 72, 60, 45], ocean: { o: 72, c: 68, e: 48, a: 74, n: 55 }, comm: null, clarity: 55 };
  const ev = [{ type: 'course' }, { type: 'project' }];
  const settings = D.DEFAULT_RULE_SETTINGS.map((s) => ({ ...s, active: 1 }));
  const list = D.recommend(p, ev, settings).filter((x) => !x.always);
  assert.ok(list.length > 0 && list.length <= 5);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].gain >= list[i].gain);
  assert.equal(list[0].id, 'internship');
  assert.equal(list[0].gain, 2.3);
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

test('a clarity rating of 0 counts as 0, and evidence sent back for proof does not count', () => {
  const p = { cgpa: 8, skills: [60, 60, 60, 60], ocean: null, comm: 70, clarity: 0 };
  assert.equal(D.score(p, []).factors.clarity, 0);
  assert.equal(D.score({ ...p, clarity: null }, []).factors.clarity, 80);
  const r = D.score(p, [{ type: 'internship', status: 'needs_proof' }, { type: 'internship', status: 'pending' }]);
  assert.equal(r.counts.internship, 1);
});

test('the counsellor referral is always included, even for a strong profile', () => {
  const p = { role: 'hr', cgpa: 9.5, skills: [95, 95, 95, 95], ocean: null, comm: 95, clarity: 95 };
  const list = D.recommend(p, [], D.DEFAULT_RULE_SETTINGS.map((s) => ({ ...s, active: 1 })));
  assert.ok(list.some((x) => x.id === 'counsellor'));
});
