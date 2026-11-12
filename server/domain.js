// Reference data, the scoring formula (v0.1) and the recommendation rules.
// The score is pure arithmetic. Nothing in this file calls an AI model.

const FORMULA_VERSION = 'v0.2';
const MIN_GROUP = 5; // aggregates for groups smaller than this are suppressed

const FACTORS = [
  { k: 'academic', label: 'Academic', w: 20, how: 'CGPA × 10. Not yet rated until you enter your CGPA.' },
  { k: 'technical', label: 'Technical / role skills', w: 20, how: 'Average of your four role-skill scores, plus 3 per verified certificate and 1.5 per verified NPTEL/SWAYAM course. Capped at 100.' },
  { k: 'projects', label: 'Projects', w: 15, how: '35 for each project your mentor has verified, capped at 100. None verified scores 0.' },
  { k: 'experience', label: 'Experience', w: 15, how: '50 for each internship your mentor has verified, capped at 100. None verified scores 0.' },
  { k: 'psychometric', label: 'Psychometric', w: 10, how: 'Average of the five personality traits you entered, with neuroticism reversed (100 − neuroticism). Not yet rated until you enter all five.' },
  { k: 'communication', label: 'Communication', w: 10, how: 'Your college communication assessment, recorded by your mentor. Not yet rated until then.' },
  { k: 'leadership', label: 'Leadership', w: 5, how: '50 for each verified NSS, NCC, club or committee role, capped at 100. None verified scores 0.' },
  { k: 'clarity', label: 'Career clarity', w: 5, how: 'Your own rating of how sure you are about your career direction. Not yet rated until you give one.' },
];

const ROLES = {
  hr: { label: 'HR / People Analytics Associate', skills: ['Excel and data analysis', 'Research methods', 'Psychometric testing basics', 'Labour law basics'], target: [70, 70, 65, 60],
    project: 'Run a short employee-wellbeing survey for a local NGO or startup and present what you find', internship: 'an HR or people-analytics internship' },
  wellbeing: { label: 'Mental Health and Wellbeing Associate', skills: ['Active listening', 'Case documentation', 'Psychological first aid', 'Ethics and confidentiality'], target: [75, 65, 70, 75],
    project: 'Co-run a peer-support or awareness programme with your college counselling centre', internship: 'a supervised placement with a hospital, NGO or counselling centre' },
  ux: { label: 'UX Researcher', skills: ['User interviews', 'Survey design', 'Usability testing', 'Figma basics'], target: [70, 70, 70, 60],
    project: 'Run a usability study on a public-service app and write it up as a case study', internship: 'a UX research internship with a product team' },
  data: { label: 'Data Analyst', skills: ['SQL', 'Python', 'Statistics', 'Data visualisation'], target: [70, 65, 70, 65],
    project: 'Analyse an open dataset from data.gov.in and publish a short dashboard', internship: 'a data or MIS internship' },
  dev: { label: 'Software Developer', skills: ['Data structures and algorithms', 'Git', 'Web development', 'Databases'], target: [70, 65, 70, 65],
    project: 'Build and deploy a small app that fixes a real campus problem', internship: 'a software development internship' },
  content: { label: 'Content and Communications Associate', skills: ['Writing and editing', 'Fact-checking', 'Social media', 'SEO basics'], target: [75, 70, 65, 55],
    project: 'Write and publish a six-part explainer series for a local organisation', internship: 'a content or communications internship' },
  marketing: { label: 'Marketing Associate', skills: ['Market research', 'Digital marketing', 'Excel', 'Presentation'], target: [65, 65, 65, 70],
    project: 'Run a market survey for a local business and pitch your recommendations', internship: 'a marketing internship' },
  founder: { label: 'Founder / Entrepreneurship', skills: ['Customer discovery', 'Business model design', 'Basic finance', 'Pitching'], target: [70, 65, 60, 70],
    project: 'Interview 20 potential users and turn what you learn into a one-page business model', internship: 'an internship at an early-stage startup or your college incubator' },
};

const PROGRAMMES = [
  { id: 'ba-psy', label: 'B.A. Psychology', years: 3 }, { id: 'ba-jour', label: 'B.A. Journalism', years: 3 },
  { id: 'bcom', label: 'B.Com', years: 3 }, { id: 'bba', label: 'BBA', years: 3 },
  { id: 'bsc-cs', label: 'B.Sc. Computer Science', years: 3 }, { id: 'btech', label: 'B.Tech. Computer Science', years: 4 },
];

const EVIDENCE_TYPES = {
  course: 'NPTEL / SWAYAM course', certificate: 'Certificate', project: 'Project', internship: 'Internship',
  role: 'NSS, NCC, club or committee role', assessment: 'College skill assessment',
};

const SLOTS = [
  { id: 'now', label: 'This semester' }, { id: 'winter', label: 'Winter break' },
  { id: 'next', label: 'Next semester' }, { id: 'summer', label: 'Summer' },
];

const CONSENT_PURPOSES = {
  profile: 'Store my profile, evidence and score so I can use NGRM',
  psychometric: 'Store my personality questionnaire results',
  ai_wording: 'Let an AI model reword the reasons for my recommendations (it never sees my name or contact details)',
  introductions: 'Let employers request an introduction through my placement cell',
  study: 'Include my de-identified data in the outcome study, with follow-ups after graduation',
};

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round1 = (n) => Math.round(n * 10) / 10;

// Only evidence a mentor (or the college) has verified counts. Claims waiting for a check add nothing yet.
function counts(evidence) {
  const c = { course: 0, certificate: 0, project: 0, internship: 0, role: 0 };
  for (const e of evidence || []) if (c[e.type] != null && e.status === 'verified') c[e.type]++;
  return c;
}
const given = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(+v);
// Formula v0.2.
// 1. Only evidence a mentor has verified counts.
// 2. A factor the student has not answered is "not yet rated" (null): it is left out, and the score is the
//    weighted average of the rated factors. `completeness` says how much of the full formula that covers.
// 3. Projects, experience and leadership start at 0 and rise with each verified item.
function score(p, evidence) {
  const c = counts(evidence);
  const f = {};
  f.academic = given(p.cgpa) ? clamp(+p.cgpa * 10) : null;
  const skills = (p.skills || []).map(Number).filter((n) => !Number.isNaN(n));
  f.technical = skills.length ? Math.min(100, avg(skills) + c.certificate * 3 + c.course * 1.5) : null;
  f.projects = Math.min(100, 35 * c.project);
  f.experience = Math.min(100, 50 * c.internship);
  const o = p.ocean;
  f.psychometric = o ? (o.o + o.c + o.e + o.a + (100 - o.n)) / 5 : null;
  f.communication = given(p.comm) ? clamp(+p.comm) : null;
  f.leadership = Math.min(100, 50 * c.role);
  f.clarity = given(p.clarity) ? clamp(+p.clarity) : null;
  let sum = 0, weight = 0;
  for (const F of FACTORS) if (f[F.k] !== null) { sum += f[F.k] * F.w; weight += F.w; }
  for (const k of Object.keys(f)) if (f[k] !== null) f[k] = round1(f[k]);
  return { version: FORMULA_VERSION, factors: f, index: weight ? round1(sum / weight) : 0, counts: c, ratedWeight: weight, completeness: weight,
    notRated: FACTORS.filter((F) => f[F.k] === null).map((F) => F.k),
    flags: { cgpaMissing: !given(p.cgpa), commUnrated: f.communication === null, psychometricMissing: !o, clarityMissing: !given(p.clarity) } };
}

function band(i) {
  if (i < 50) return { k: 'building', label: 'Building' };
  if (i < 75) return { k: 'progressing', label: 'Progressing' };
  return { k: 'ready', label: 'Ready' };
}

// ---------- Recommendation rules ----------
// Each rule: when it applies, how its effect is simulated (to rank by score gain), and its text.
// Thresholds, timing, effort and on/off live in the `rules` table so an admin can change them.
const weakest = (p) => p.skills.reduce((w, s, i, a) => (+s < +a[w] ? i : w), 0);
const withEv = (ev, type) => ev.concat([{ type, status: 'verified' }]);
const clone = (o) => JSON.parse(JSON.stringify(o));

const RULES = {
  course: {
    applies: (p, r, t) => p.skills.length && +p.skills[weakest(p)] < t,
    sim: (p, ev) => { const q = clone(p); const i = weakest(q); q.skills[i] = Math.min(100, +q.skills[i] + 15); return [q, withEv(ev, 'course')]; },
    assume: 'Assumes the course lifts that skill by 15 points and the certificate is verified.',
    title: (p) => `Take an NPTEL or SWAYAM course in ${ROLES[p.role].skills[weakest(p)].toLowerCase()}`,
    what: () => 'Pick a course on this skill and sit the proctored exam, so the certificate counts as verified evidence.',
    why: (p) => { const i = weakest(p); return `${ROLES[p.role].skills[i]} is your weakest role skill at ${p.skills[i]}/100, against a target of ${ROLES[p.role].target[i]}. Technical and role skills carry 20% of your score.`; },
  },
  project: {
    applies: (p, r, t) => r.counts.project < t,
    sim: (p, ev) => [p, withEv(ev, 'project')],
    assume: 'Counts one more project, once your mentor has verified it.',
    title: () => 'Do one applied project',
    what: (p) => `${ROLES[p.role].project}.`,
    why: (p, r) => `Projects carry 15% of your score. You have ${r.counts.project} completed project${r.counts.project === 1 ? '' : 's'}, which gives ${Math.round(r.factors.projects)}/100. Each verified project adds 35.`,
  },
  internship: {
    applies: (p, r, t) => r.counts.internship < t,
    sim: (p, ev) => [p, withEv(ev, 'internship')],
    assume: 'Counts one internship, once your mentor has verified it.',
    title: () => 'Line up a summer internship',
    what: (p) => `Aim for ${ROLES[p.role].internship}. Start with your placement cell; the AICTE internship portal also lists openings for students.`,
    why: (p, r) => `Experience carries 15% of your score. ${r.counts.internship === 0 ? 'You have no verified internships yet, so this factor is at 0.' : `You are at ${Math.round(r.factors.experience)}/100.`}`,
  },
  communication: {
    // Shown when the student has not been assessed, or was assessed below the threshold.
    applies: (p, r, t) => r.factors.communication === null || r.factors.communication < t,
    sim: (p, ev) => { if (!given(p.comm)) return [p, ev]; const q = clone(p); q.comm = Math.round(Math.min(100, +p.comm + 12)); return [q, ev]; },
    assume: 'Assumes a 12-point gain at your next assessment. No points are projected until you have been assessed once.',
    title: (p) => (given(p.comm) ? 'Practise speaking, then get re-assessed' : 'Take the college communication assessment'),
    what: (p) => (given(p.comm) ? 'Join a debate, theatre or public-speaking club for a semester, then ask your mentor for a fresh communication assessment.' : 'Ask your mentor when the college communication assessment runs. A debate, theatre or public-speaking club is good practice beforehand.'),
    why: (p, r) => (r.flags.commUnrated ? 'Communication carries 10% of the score, but yours has not been assessed yet, so it is left out of your total for now.' : `Your assessed communication score is ${Math.round(r.factors.communication)}/100. It carries 10% of your score.`),
  },
  academic: {
    applies: (p, r, t) => !r.flags.cgpaMissing && +p.cgpa < t,
    sim: (p, ev) => { const q = clone(p); q.cgpa = Math.min(10, +q.cgpa + 0.5); return [q, ev]; },
    assume: 'Assumes your CGPA rises by 0.5.',
    title: () => 'Lift your CGPA by half a point',
    what: () => 'Use tutorial hours for your two weakest papers and plan revision a month before end-semester exams.',
    why: (p, r) => `Academic performance carries 20% of your score. A CGPA of ${p.cgpa} gives ${Math.round(r.factors.academic)}/100.`,
  },
  leadership: {
    applies: (p, r) => r.counts.role === 0,
    sim: (p, ev) => [p, withEv(ev, 'role')],
    assume: 'Moves leadership from 0 to 50, once your mentor has verified the role.',
    title: () => 'Take on a responsibility role',
    what: () => 'Volunteer with NSS or NCC, or lead a club event or a student committee this year.',
    why: () => 'Leadership carries 5% of your score. With no verified role on record it is at 0; one role moves it to 50.',
  },
  clarity: {
    applies: (p, r, t) => r.factors.clarity !== null && r.factors.clarity < t,
    sim: (p, ev) => { const q = clone(p); q.clarity = Math.min(100, (+q.clarity || 0) + 20); return [q, ev]; },
    assume: 'Assumes your confidence rating rises by 20.',
    title: () => 'Test your career direction',
    what: (p) => `Shortlist two roles, including ${ROLES[p.role].label}, and talk to one working person in each. Then re-rate your confidence with your mentor.`,
    why: (p, r) => `You rated your career confidence ${Math.round(r.factors.clarity)}/100. It carries only 5% of your score, but it sharpens every other step in the plan.`,
  },
  counsellor: {
    // Always offered. The threshold only decides whether it is flagged as a priority.
    applies: () => true,
    sim: (p, ev) => [p, ev],
    assume: 'Not scored. Always available.',
    title: () => 'Talk to a human career counsellor',
    what: () => 'Book a session with your college counsellor. You can do this at any time, with or without the rest of the plan.',
    why: (p, r, t) => (t != null && r.factors.clarity !== null && r.factors.clarity < t
      ? 'Your career clarity is low. A conversation with a person often helps more than any score.'
      : 'A conversation with a person can test this plan against what you actually want. No score can do that.'),
    always: true,
  },
};

const DEFAULT_RULE_SETTINGS = [
  { id: 'course', factor: 'technical', slot: 'now', effort: '6–8 weeks, about 3 hours a week', threshold: 60 },
  { id: 'project', factor: 'projects', slot: 'next', effort: 'One semester', threshold: 3 },
  { id: 'internship', factor: 'experience', slot: 'summer', effort: '6–8 weeks over summer', threshold: 2 },
  { id: 'communication', factor: 'communication', slot: 'next', effort: 'One semester of practice', threshold: 85 },
  { id: 'academic', factor: 'academic', slot: 'next', effort: 'Through end-semester exams', threshold: 8.5 },
  { id: 'leadership', factor: 'leadership', slot: 'next', effort: 'A few hours a week', threshold: null },
  { id: 'clarity', factor: 'clarity', slot: 'winter', effort: '3–4 conversations over the break', threshold: 75 },
  { id: 'counsellor', factor: 'clarity', slot: 'now', effort: 'One conversation', threshold: 40 },
];

// Allowed threshold range per rule, so an admin cannot switch a rule off by typing a nonsense value.
const THRESHOLD_RANGE = { course: [0, 100], project: [0, 10], internship: [0, 10], communication: [0, 100], academic: [0, 10], clarity: [0, 100], counsellor: [0, 100] };

/** Rank applicable rules by simulated score gain. Returns at most 5, plus the counsellor referral when it applies. */
function recommend(p, evidence, settings) {
  const r = score(p, evidence);
  const out = [];
  for (const s of settings) {
    const rule = RULES[s.id];
    if (!rule || !s.active || !rule.applies(p, r, s.threshold)) continue;
    const [q, ev] = rule.sim(p, evidence);
    const gain = round1(score(q, ev).index - r.index);
    if (gain <= 0.05 && !rule.always) continue;
    out.push({ id: s.id, factor: s.factor, slot: s.slot, effort: s.effort, gain, always: !!rule.always,
      title: rule.title(p, r), what: rule.what(p, r), why: rule.why(p, r, s.threshold), assume: rule.assume });
  }
  const scored = out.filter((x) => !x.always).sort((a, b) => b.gain - a.gain).slice(0, 5);
  return scored.concat(out.filter((x) => x.always));
}

/** Score after completing the given accepted rules, applied in turn. */
function projectIndex(p, evidence, ruleIds) {
  let q = clone(p), ev = evidence.slice();
  for (const id of ruleIds) { const rule = RULES[id]; if (rule) { [q, ev] = rule.sim(q, ev); } }
  return score(q, ev).index;
}

module.exports = { projectIndex, FORMULA_VERSION, MIN_GROUP, FACTORS, ROLES, PROGRAMMES, EVIDENCE_TYPES, SLOTS, CONSENT_PURPOSES,
  DEFAULT_RULE_SETTINGS, THRESHOLD_RANGE, weakest, score, band, recommend, counts, avg, round1, clamp };
