// Reference data, the scoring formula and the recommendation rules.
// The score is pure arithmetic. Nothing in this file calls an AI model.

const L = require('./library');

const FORMULA_VERSION = 'v0.4';
const MIN_GROUP = 5; // aggregates for groups smaller than this are suppressed
const HALF = 0.5; // what a self-reported item counts for until it is confirmed

// Formula v0.4 (from the advisers' review, November 2026). Academic excellence is the largest part, because employers judge
// entry-level graduates on their discipline: CGPA, internships and projects together carry 35%.
const FACTORS = [
  { k: 'cgpa', group: 'academic', label: 'CGPA', w: 15, how: 'CGPA × 10. It counts in full once your mentor confirms it against college records, and at half until then. A first-year student with no CGPA yet can enter their Class 12 percentage instead, which is used until the first CGPA. Not rated until you enter one of them.' },
  { k: 'internships', group: 'academic', label: 'Internships', w: 10, how: '50 for each internship your mentor has verified, capped at 100. One waiting for your mentor counts at half (25), and items waiting can add at most 50 in all. One your mentor asked proof for counts 0 until you add it.' },
  { k: 'projects', group: 'academic', label: 'Projects and dissertation', w: 10, how: '35 for each project or dissertation your mentor has verified, capped at 100. One waiting for your mentor counts at half, and items waiting can add at most 50 in all.' },
  { k: 'technical', label: 'Technical skills for your aspired role', w: 20, how: 'Average of the four skills your aspired role needs. A skill your college has assessed counts in full, your own rating counts at half, and a skill you have not rated counts 0. Plus 3 per verified certificate and 1.5 per verified NPTEL or SWAYAM course (half while waiting). Capped at 100.' },
  { k: 'transversal', label: 'Transversal skills', w: 20, how: 'Average of communication, leadership, creativity, problem solving and teamwork. A skill your mentor has assessed counts in full, your own rating at half, and one not rated counts 0. Not rated until you rate at least one.' },
  { k: 'socioemotional', label: 'Social-emotional', w: 10, how: 'From the 20-question personality questionnaire on this page (the Mini-IPIP, a public-domain Big Five measure): the average of your conscientiousness and emotional stability, 0–100. Your full five-trait profile is shown only to you. Not rated until you answer all 20.' },
  { k: 'cocurricular', label: 'Co-curricular achievements', w: 10, how: '50 for each achievement beyond your course that your mentor has verified: a hackathon, a competition, NSS or NCC, a club or committee role, or volunteering. Capped at 100. One waiting for your mentor counts at half, and items waiting can add at most 50 in all.' },
  { k: 'clarity', label: 'Career clarity', w: 5, how: 'Your own rating of how sure you are about your career direction. Not rated until you give one.' },
];
const GROUPS = [{ k: 'academic', label: 'Academic excellence', w: 35, parts: ['cgpa', 'internships', 'projects'] }];
// Skills every job needs, whatever the discipline. The student rates them; a mentor can assess them.
const TRANSVERSAL = ['Communication', 'Leadership', 'Creativity', 'Problem solving', 'Teamwork'];
const TRANSVERSAL_PRACTICE = [
  'Join a debate, theatre or public-speaking club for a semester, or give a short talk in class',
  'Lead a club event, a study circle or a class activity from start to finish',
  'Enter a design challenge, a hackathon or a creative project where you make something new',
  'Take part in a case competition, a quiz or a coding contest, or solve a real problem for a local organisation',
  'Work in a team on a group project or a volunteering drive, and take a clear role in it',
];
// The Mini-IPIP (Donnellan, Oswald, Baird & Lucas, 2006): 20 public-domain IPIP items, 4 per trait, answered 1–5
// (very inaccurate to very accurate). r = reverse-keyed (scored 6 − answer).
const IPIP = [
  ['Am the life of the party.', 'e', 0], ['Sympathize with others’ feelings.', 'a', 0], ['Get chores done right away.', 'c', 0], ['Have frequent mood swings.', 'n', 0], ['Have a vivid imagination.', 'o', 0],
  ['Don’t talk a lot.', 'e', 1], ['Am not interested in other people’s problems.', 'a', 1], ['Often forget to put things back in their proper place.', 'c', 1], ['Am relaxed most of the time.', 'n', 1], ['Am not interested in abstract ideas.', 'o', 1],
  ['Talk to a lot of different people at parties.', 'e', 0], ['Feel others’ emotions.', 'a', 0], ['Like order.', 'c', 0], ['Get upset easily.', 'n', 0], ['Have difficulty understanding abstract ideas.', 'o', 1],
  ['Keep in the background.', 'e', 1], ['Am not really interested in others.', 'a', 1], ['Make a mess of things.', 'c', 1], ['Seldom feel blue.', 'n', 1], ['Do not have a good imagination.', 'o', 1],
].map(([t, k, r]) => ({ t, k, r: !!r }));
const IPIP_SCALE = ['Very inaccurate', 'Moderately inaccurate', 'Neither inaccurate nor accurate', 'Moderately accurate', 'Very accurate'];
const TRAIT_NAMES = { o: 'Openness', c: 'Conscientiousness', e: 'Extraversion', a: 'Agreeableness', n: 'Neuroticism' };
/** Trait scores 0–100 from 20 answers (each 1–5), or null if any answer is missing. */
function ipipTraits(answers) {
  if (!Array.isArray(answers) || answers.length !== 20 || answers.some((a) => !(Number.isInteger(+a) && +a >= 1 && +a <= 5))) return null;
  const sum = { o: 0, c: 0, e: 0, a: 0, n: 0 };
  IPIP.forEach((it, i) => { sum[it.k] += it.r ? 6 - +answers[i] : +answers[i]; });
  // Each trait is the sum of 4 items (4–20), put on 0–100.
  return Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, Math.round((v - 4) / 16 * 100)]));
}

const ROLES = {
  hr: { family: 'hr', listed: true, label: 'HR / People Analytics Associate', skills: ['Excel and data analysis', 'Research methods', 'Psychometric testing basics', 'Labour law basics'], target: [70, 70, 65, 60],
    project: 'Run a short employee-wellbeing survey for a local NGO or startup and present what you find', internship: 'an HR or people-analytics internship' },
  wellbeing: { family: 'wellbeing', listed: true, label: 'Mental Health and Wellbeing Associate', skills: ['Active listening', 'Case documentation', 'Psychological first aid', 'Ethics and confidentiality'], target: [75, 65, 70, 75],
    project: 'Co-run a peer-support or awareness programme with your college counselling centre', internship: 'a supervised placement with a hospital, NGO or counselling centre' },
  ux: { family: 'ux', listed: true, label: 'UX Researcher', skills: ['User interviews', 'Survey design', 'Usability testing', 'Figma basics'], target: [70, 70, 70, 60],
    project: 'Run a usability study on a public-service app and write it up as a case study', internship: 'a UX research internship with a product team' },
  data: { family: 'data', listed: true, label: 'Data Analyst', skills: ['SQL', 'Python', 'Statistics', 'Data visualisation'], target: [70, 65, 70, 65],
    project: 'Analyse an open dataset from data.gov.in and publish a short dashboard', internship: 'a data or MIS internship' },
  dev: { family: 'software', listed: true, label: 'Software Developer', skills: ['Data structures and algorithms', 'Git', 'Web development', 'Databases'], target: [70, 65, 70, 65],
    project: 'Build and deploy a small app that fixes a real campus problem', internship: 'a software development internship' },
  content: { family: 'content', listed: true, label: 'Content and Communications Associate', skills: ['Writing and editing', 'Fact-checking', 'Social media', 'SEO basics'], target: [75, 70, 65, 55],
    project: 'Write and publish a six-part explainer series for a local organisation', internship: 'a content or communications internship' },
  marketing: { family: 'marketing', listed: true, label: 'Marketing Associate', skills: ['Market research', 'Digital marketing', 'Excel', 'Presentation'], target: [65, 65, 65, 70],
    project: 'Run a market survey for a local business and pitch your recommendations', internship: 'a marketing internship' },
  founder: { family: 'founder', listed: true, label: 'Founder / Entrepreneurship', skills: ['Customer discovery', 'Business model design', 'Basic finance', 'Pitching'], target: [70, 65, 60, 70],
    project: 'Interview 20 potential users and turn what you learn into a one-page business model', internship: 'an internship at an early-stage startup or your college incubator' },
};

const PROGRAMMES = [
  { id: 'ba-psy', discipline: 'psychology', listed: true, label: 'B.A. Psychology', years: 3 }, { id: 'ba-jour', discipline: 'media', listed: true, label: 'B.A. Journalism', years: 3 },
  { id: 'bcom', discipline: 'commerce', listed: true, label: 'B.Com', years: 3 }, { id: 'bba', discipline: 'management', listed: true, label: 'BBA', years: 3 },
  { id: 'bsc-cs', discipline: 'cs', listed: true, label: 'B.Sc. Computer Science', years: 3 }, { id: 'btech', discipline: 'cs', listed: true, label: 'B.Tech. Computer Science', years: 4 },
];

// Roles and programmes people have typed are added to these at start-up and whenever one is created (see app.js).
const BUILT_IN_ROLES = Object.keys(ROLES), BUILT_IN_PROGRAMMES = PROGRAMMES.map((x) => x.id);
const programme = (id) => PROGRAMMES.find((x) => x.id === id) || { id, label: 'your programme', years: 3, discipline: 'general' };
const fitOf = (p) => L.fit(programme(p.prog).discipline, (ROLES[p.role] || {}).family || 'general');
// One short, plain note on how this programme relates to this role. It shapes the wording of the plan, never the score.
function pathNote(p) {
  const R = ROLES[p.role], P = programme(p.prog), f = fitOf(p), d = L.DISCIPLINES.find((x) => x.k === P.discipline);
  const two = R.skills.map((s, i) => [s, +p.skills[i] || 0]).sort((a, b) => a[1] - b[1]).slice(0, 2).map((x) => x[0].toLowerCase()).join(' and ');
  const text = {
    direct: `${P.label} leads naturally to ${R.label}. Your coursework covers the base, so what sets you apart is proof: assessed skills, a finished project and an internship.`,
    related: `${P.label} is a workable base for ${R.label}. Some of what the role needs comes from your programme; plan to build ${two} outside class.`,
    switch: `${R.label} is a change of direction from ${d ? d.name : P.label}. That is common and doable, but your degree alone will not be read as evidence for this role, so courses with proctored exams, a finished project and an internship matter more for you than for most.`,
    open: `Your plan is built around ${R.label} and ${P.label} as you typed them. ${R.needsReview ? 'This role is new to GRM, so it starts with general workplace skills until the GRM admin sets the specific ones.' : 'Ask your mentor how others have made this move.'}`,
  }[f];
  return { fit: f, label: L.FIT_LABEL[f], text };
}

const EVIDENCE_TYPES = {
  course: 'NPTEL / SWAYAM course', certificate: 'Certificate', project: 'Project or dissertation', internship: 'Internship',
  role: 'Co-curricular: hackathon, competition, NSS, NCC, club role or volunteering', assessment: 'College assessment',
};

const SLOTS = [
  { id: 'now', label: 'This semester' }, { id: 'winter', label: 'Winter break' },
  { id: 'next', label: 'Next semester' }, { id: 'summer', label: 'Summer' },
];

const CONSENT_PURPOSES = {
  profile: 'Store my profile, evidence and score so I can use GRM',
  psychometric: 'Store my answers to the personality questionnaire',
  ai_wording: 'Let an AI model reword the reasons for my recommendations (it never sees my name or contact details)',
  ai_proof_check: 'Let an AI model take a first look at proof files I upload, to help my mentor check them (it reads the file, which may show my name; my mentor still decides)',
  introductions: 'Let employers request an introduction through my placement cell',
  study: 'Include my de-identified data in the outcome study, with follow-ups after graduation',
};

// Volunteer mentors (advisers' review, November 2026): where they work or worked.
const SECTORS = { industry: 'Industry', government: 'Government', education: 'Education', other: 'Other' };
// Kinds of mentoring time a mentor can log towards a certificate of hours.
const SESSION_KINDS = { one_to_one: 'One-to-one session', group: 'Group session', review: 'Reviewing work or proof' };
// Where an opening added by the GRM team was found. Students see the source named and linked.
const SOURCE_KINDS = { company: 'Company careers page', government: 'Government recruitment notice', employment_news: 'Employment News', agency: 'Recruitment agency, with its client’s agreement', partner: 'Partner organisation', portal: 'Job portal listing' };

const clamp = (v, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round1 = (n) => Math.round(n * 10) / 10;

// Evidence by status. Verified counts in full; waiting for the mentor counts at half; "needs proof" counts nothing until proof is added.
function counts(evidence) {
  const c = { course: 0, certificate: 0, project: 0, internship: 0, role: 0 };
  for (const e of evidence || []) if (c[e.type] != null && e.status === 'verified') c[e.type]++;
  return c;
}
function waitingCounts(evidence) {
  const c = { course: 0, certificate: 0, project: 0, internship: 0, role: 0 };
  for (const e of evidence || []) if (c[e.type] != null && e.status === 'pending') c[e.type]++;
  return c;
}
const given = (v) => v !== null && v !== undefined && v !== '' && !Number.isNaN(+v);
// One skill's contribution: assessed in full, the student's own rating at `half`, not rated 0.
const skillValue = (v, rated, assessed, half) => (assessed ? +v || 0 : rated ? (+v || 0) * half : 0);

// Formula v0.4.
// 0. The student is never kept waiting: a score and a plan come at once. What they report about themselves (CGPA, skill
//    ratings, evidence not yet checked) counts at half until a mentor confirms it, and in full after.
// 1. Evidence a mentor asked proof for counts nothing until the proof is added.
// 2. A factor the student has not answered is "not yet rated" (null): it is left out, and the score is the weighted average
//    of the rated factors. `completeness` says how much of the full formula that covers.
// 3. `confirmedIndex` is the same score counting only what has been confirmed, for anyone who needs that view.
function compute(p, evidence, half) {
  const c = counts(evidence), w = waitingCounts(evidence);
  const f = {};
  // Until a first CGPA exists, Class 12 marks (a percentage) stand in for it, on the same terms.
  f.cgpa = given(p.cgpa) ? clamp(+p.cgpa * 10) * (p.cgpaConfirmed ? 1 : half) : given(p.class12) ? clamp(+p.class12) * (p.class12Confirmed ? 1 : half) : null;
  // Items waiting for the mentor can add at most half of a factor, so a list of unchecked claims can never fill it.
  const capped = (per, verified, waiting) => Math.min(100, per * verified + Math.min(50, per * waiting * half));
  f.internships = capped(50, c.internship, w.internship);
  f.projects = capped(35, c.project, w.project);
  const sk = p.skills || [], n = Math.max(1, sk.length);
  const rated = (i) => !p.skillsRated || p.skillsRated[i], assessed = (i) => !!(p.skillsVerified && p.skillsVerified[i]);
  // Averaged over all the role's skills, so each new rating or assessment can only add.
  f.technical = Math.min(100, sk.reduce((t, v, i) => t + skillValue(v, rated(i), assessed(i), half), 0) / n + c.certificate * 3 + c.course * 1.5 + Math.min(10, (w.certificate * 3 + w.course * 1.5) * half));
  const tv = p.transversal || [], tvA = p.transversalVerified || [];
  const tvAny = TRANSVERSAL.some((_, i) => given(tv[i]) || tvA[i]);
  f.transversal = tvAny ? TRANSVERSAL.reduce((t, _, i) => t + skillValue(tv[i], given(tv[i]), !!tvA[i], half), 0) / TRANSVERSAL.length : null;
  const o = p.ocean;
  f.socioemotional = o && given(o.c) && given(o.n) ? (+o.c + (100 - +o.n)) / 2 : null;
  f.cocurricular = capped(50, c.role, w.role);
  f.clarity = given(p.clarity) ? clamp(+p.clarity) : null;
  let sum = 0, weight = 0;
  for (const F of FACTORS) if (f[F.k] !== null) { sum += f[F.k] * F.w; weight += F.w; }
  for (const k of Object.keys(f)) if (f[k] !== null) f[k] = round1(f[k]);
  return { f, c, w, index: weight ? round1(sum / weight) : 0, weight };
}
function score(p, evidence) {
  const r = compute(p, evidence, HALF), sure = compute(p, evidence, 0);
  const sk = p.skills || [], assessed = sk.filter((_, i) => p.skillsVerified && p.skillsVerified[i]).length;
  const tv = p.transversal || [], tvA = p.transversalVerified || [];
  const groups = Object.fromEntries(GROUPS.map((G) => { const parts = G.parts.map((k) => [k, r.f[k], FACTORS.find((F) => F.k === k).w]).filter((x) => x[1] !== null);
    return [G.k, parts.length ? round1(parts.reduce((t, x) => t + x[1] * x[2], 0) / parts.reduce((t, x) => t + x[2], 0)) : null]; }));
  return { version: FORMULA_VERSION, factors: r.f, groups, index: r.index, confirmedIndex: sure.index, counts: r.c, waiting: r.w, ratedWeight: r.weight, completeness: r.weight,
    notRated: FACTORS.filter((F) => r.f[F.k] === null).map((F) => F.k),
    skillsAssessed: assessed,
    flags: { cgpaMissing: !given(p.cgpa) && !given(p.class12), cgpaUnconfirmed: given(p.cgpa) ? !p.cgpaConfirmed : given(p.class12) && !p.class12Confirmed, marksFrom: given(p.cgpa) ? 'cgpa' : given(p.class12) ? 'class12' : null, skillsUnassessed: sk.length - assessed,
      transversalMissing: r.f.transversal === null, transversalUnassessed: TRANSVERSAL.filter((_, i) => given(tv[i]) && !tvA[i]).length,
      waitingEvidence: Object.values(r.w).reduce((a, b) => a + b, 0), psychometricMissing: r.f.socioemotional === null, clarityMissing: !given(p.clarity) } };
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

// ---------- Recommendations ----------
// Every step is built from this student's own data: their four role skills and how each was rated or assessed, the
// employers' posts for their role (skills, cities, extra skills they typed), how their programme relates to the role,
// how much of the degree is left, what they wrote in their own words, and, where 5 or more exist, students at their
// college aiming for the same role. Each step lists those facts under "Built from", so the student can see why it is theirs.
//
// ctx (all optional): { yearsLeft, words: { goal, interests, cities, ownSkills: [{ name, level }] },
//   goal: { text, family, roleLabel } | null,
//   demand: { bySkill: [openings per role skill], extra: [{ name, openings, have }], cityPosts: [{ employer, city, openings }] },
//   peers: { label, n, has: { internship, project, role, certificate } } | null }   (has.* are rounded percentages or null)

const TYPE_FACTOR = { internship: 'internships', project: 'projects', course: 'technical', certificate: 'technical', role: 'cocurricular' };
const TYPE_NAME = { internship: 'internship', project: 'project', course: 'course', certificate: 'certificate', role: 'co-curricular achievement' };
const listOf = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const lower = (t) => String(t).charAt(0).toLowerCase() + String(t).slice(1);
// A skill name inside a sentence: lower case, except names and abbreviations (Excel, SQL, Figma, Power BI).
const KEEP = /^(excel|sql|python|git|figma|adobe|cad|crm|gst|linux|english|kannada|hindi|tally|power|seo|ui|ux|ai|ml|r)\b/i;
const skillWord = (t) => (KEEP.test(t) || /^[A-Z]{2,}/.test(t) ? String(t) : lower(t));

// How a skill stands for this student, in words.
function skillState(p, i) {
  if (p.skillsVerified && p.skillsVerified[i]) return `assessed at ${p.skills[i]}`;
  if (p.skillsRated && !p.skillsRated[i]) return 'not rated yet';
  return `your own rating ${p.skills[i]}, counting at half until assessed`;
}
// The skill to work on next: the biggest gap to the role's target, weighted up by how many openings employers posted for it.
function focusSkill(p, ctx) {
  const R = ROLES[p.role], d = (ctx && ctx.demand && ctx.demand.bySkill) || [], total = d.reduce((a, b) => a + (b || 0), 0);
  let best = weakest(p), bestScore = -1;
  R.skills.forEach((_, i) => {
    const level = p.skillsRated && !p.skillsRated[i] && !(p.skillsVerified && p.skillsVerified[i]) ? 0 : +p.skills[i] || 0;
    const gap = Math.max(0, R.target[i] - level), weight = gap * (1 + (total ? (d[i] || 0) / total : 0));
    if (weight > bestScore) { best = i; bestScore = weight; }
  });
  return best;
}
// Of the evidence waiting for the mentor, the one that matters most: proof requested first, then the biggest score gain.
function proofPick(p, ev) {
  const waiting = (ev || []).map((e, k) => ({ e, k })).filter((x) => x.e.type !== 'assessment' && TYPE_FACTOR[x.e.type] && (x.e.status === 'pending' || x.e.status === 'needs_proof'));
  if (!waiting.length) return null;
  const base = score(p, ev).index;
  const gainOf = (x) => score(p, ev.map((e, k) => (k === x.k ? { ...e, status: 'verified' } : e))).index - base;
  waiting.sort((a, b) => (b.e.status === 'needs_proof') - (a.e.status === 'needs_proof') || gainOf(b) - gainOf(a) || a.k - b.k);
  return { ...waiting[0], others: waiting.length - 1 };
}
const interestsOf = (ctx) => String((ctx && ctx.words && ctx.words.interests) || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
const peerChip = (ctx, type) => {
  const v = ctx && ctx.peers && ctx.peers.has && ctx.peers.has[type];
  return v == null ? null : `Peers at your college: about ${v}% have one`;
};
const peerLine = (ctx, type) => {
  const v = ctx && ctx.peers && ctx.peers.has && ctx.peers.has[type];
  return v == null ? null : `About ${v}% of ${ctx.peers.label} have a verified ${TYPE_NAME[type]}.`;
};
const pathOf = (p) => L.FIT_LABEL[fitOf(p)].toLowerCase();

// The transversal skill to work on next: the lowest, counting a skill not rated as 0.
function weakTransversal(p) {
  const tv = p.transversal || [], tvA = p.transversalVerified || [];
  let best = 0, low = Infinity;
  TRANSVERSAL.forEach((_, i) => { const v = given(tv[i]) ? +tv[i] : 0; const eff = tvA[i] ? v : v * HALF; if (eff < low) { low = eff; best = i; } });
  return best;
}
// What stands for the CGPA: the CGPA itself, or Class 12 marks until the first CGPA.
const marksName = (p) => (given(p.cgpa) ? 'CGPA' : 'Class 12 marks');
const marksText = (p, cap) => (given(p.cgpa) ? `${cap ? 'CGPA' : 'CGPA of'} ${p.cgpa}` : `${cap ? 'Class 12 marks' : 'Class 12 marks of'} ${p.class12}%`);
const tvState = (p, i) => { const tv = p.transversal || [], tvA = p.transversalVerified || []; return tvA[i] ? `assessed at ${tv[i]}` : given(tv[i]) ? `your own rating ${tv[i]}, counting at half until assessed` : 'not rated yet'; };

const RULES = {
  confirm: {
    // Nothing waits on this: the score already counts these at half. Confirmation turns half into full.
    applies: (p, r) => r.flags.cgpaUnconfirmed || (r.flags.skillsUnassessed > 0 && (p.skillsRated || []).some((x, i) => x && !(p.skillsVerified && p.skillsVerified[i]))) || r.flags.transversalUnassessed > 0,
    // No gain is projected: the result depends on what the college finds, which may be higher or lower than the student's own figures.
    sim: (p, ev) => [p, ev],
    assume: 'Not projected. These already count at half; once confirmed they count in full at whatever your college finds.',
    always: true, first: true,
    title: (p, r) => (r.flags.cgpaUnconfirmed ? `When you next meet your mentor, get your ${marksName(p)} and ratings confirmed` : 'When you next meet your mentor, get your ratings assessed'),
    what: (p, r) => {
      const sk = ROLES[p.role].skills.map((s, i) => ((p.skillsRated || [])[i] && !(p.skillsVerified && p.skillsVerified[i]) ? skillWord(s) : null)).filter(Boolean);
      const tv = TRANSVERSAL.map((s, i) => (given((p.transversal || [])[i]) && !(p.transversalVerified || [])[i] ? lower(s) : null)).filter(Boolean);
      return [r.flags.cgpaUnconfirmed ? `Show your marks card so your mentor can confirm your ${marksText(p)}.` : '', sk.length ? `Ask when the college assessment runs for ${listOf(sk)}.` : '', tv.length ? `Your mentor can assess your ${listOf(tv)} from what they have seen of you.` : '', 'You do not need to wait for this: keep working on the rest of your plan.'].filter(Boolean).join(' '); },
    why: (p, r) => `What you report about yourself counts at half until your college confirms it, then in full. ${r.flags.cgpaUnconfirmed ? `Your ${marksName(p)} ${given(p.cgpa) ? 'is' : 'are'} counting at half for now. ` : ''}Confirmed figures are also what employers and your placement cell can trust.`,
    because: (p, r) => [r.flags.cgpaUnconfirmed ? `${marksText(p, true)}, counting at half until confirmed` : null]
      .concat(ROLES[p.role].skills.map((k, i) => ((p.skillsRated || [])[i] && !(p.skillsVerified && p.skillsVerified[i]) ? `${k}: ${skillState(p, i)}` : null)))
      .concat(TRANSVERSAL.map((k, i) => (given((p.transversal || [])[i]) && !(p.transversalVerified || [])[i] ? `${k}: ${tvState(p, i)}` : null))).filter(Boolean),
  },
  proof: {
    applies: (p, r, t, ctx, ev) => !!proofPick(p, ev),
    sim: (p, ev) => { const x = proofPick(p, ev); return x ? [p, ev.map((e, k) => (k === x.k ? { ...e, status: 'verified' } : e))] : [p, ev]; },
    assume: 'Counts this item in full once your mentor has verified it.',
    factor: (p, r, ctx, ev) => TYPE_FACTOR[proofPick(p, ev).e.type],
    title: (p, r, ctx, ev) => { const x = proofPick(p, ev); return x.e.status === 'needs_proof' ? `Add proof for “${x.e.title}”` : `Get “${x.e.title}” verified`; },
    what: (p, r, ctx, ev) => { const x = proofPick(p, ev);
      return (x.e.status === 'needs_proof' ? 'Your mentor asked for proof before they can verify it. On Evidence, upload the certificate, offer letter or report (PDF, PNG or JPEG, up to 5 MB).' : `Your ${TYPE_NAME[x.e.type]} is already counting at half.${x.e.has_file ? '' : ' Uploading the certificate or letter on Evidence makes it quicker to verify.'} Mention it at your next meeting with your mentor.`)
        + (x.others ? ` You have ${plural(x.others, 'other item')} waiting too.` : ''); },
    why: (p, r, t, ctx, ev) => { const x = proofPick(p, ev), f = FACTORS.find((k) => k.k === TYPE_FACTOR[x.e.type]); return x.e.status === 'needs_proof' ? `It counts nothing until your mentor can check it.${f ? ` ${f.label} carries ${f.w}% of your score.` : ''}` : `You have already done this. Verified, it counts in full instead of at half.${f ? ` ${f.label} carries ${f.w}% of your score.` : ''}`; },
    because: (p, r, ctx, ev) => { const x = proofPick(p, ev); return [`“${x.e.title}”: ${x.e.status === 'needs_proof' ? 'your mentor asked for proof' : 'waiting for your mentor, counting at half'}`]; },
  },
  course: {
    applies: (p, r, t, ctx) => p.skills.length && (+p.skills[focusSkill(p, ctx)] < t || (p.skillsRated && !p.skillsRated[focusSkill(p, ctx)])),
    // A rated skill is assumed to rise by 15; a skill not rated yet is assumed to reach 50, a working foundation.
    sim: (p, ev, ctx) => { const q = clone(p); const i = focusSkill(q, ctx); q.skills[i] = q.skillsRated && !q.skillsRated[i] && !(q.skillsVerified && q.skillsVerified[i]) ? 50 : Math.min(100, +q.skills[i] + 15); q.skillsRated = (q.skillsRated || q.skills.map(() => true)).slice(); q.skillsRated[i] = true; q.skillsVerified = (q.skillsVerified || q.skills.map(() => false)).slice(); q.skillsVerified[i] = true; return [q, withEv(ev, 'course')]; },
    assume: (p, ctx) => { const i = focusSkill(p, ctx); return p.skillsRated && !p.skillsRated[i] && !(p.skillsVerified && p.skillsVerified[i]) ? 'Assumes the course takes this skill to 50/100, your college then assesses it at that level, and the certificate is verified. The assessed result may differ.' : 'Assumes the course lifts that skill by 15 points, your college then assesses it at that level, and the certificate is verified. The assessed result may differ.'; },
    skill: (p, ctx) => focusSkill(p, ctx),
    title: (p, r, ctx) => `Take an NPTEL or SWAYAM course in ${skillWord(ROLES[p.role].skills[focusSkill(p, ctx)])}`,
    what: (p, r, ctx) => { const i = focusSkill(p, ctx), k = ROLES[p.role].skills[i].toLowerCase(), own = ((ctx && ctx.words && ctx.words.ownSkills) || []).find((s) => k.includes(L.norm(s.name)) || L.norm(s.name).includes(k));
      return `Pick a course on ${skillWord(ROLES[p.role].skills[i])} and sit the proctored exam, so the certificate counts as verified evidence.${own ? ` You listed ${own.name} among your own skills, so start at the intermediate level rather than the beginning.` : ''}`; },
    why: (p, r, t, ctx) => { const i = focusSkill(p, ctx), R = ROLES[p.role], a = p.skillsVerified && p.skillsVerified[i], unrated = !a && p.skillsRated && !p.skillsRated[i], d = ctx && ctx.demand && ctx.demand.bySkill ? ctx.demand.bySkill[i] || 0 : 0;
      const lead = unrated ? `You have not rated ${skillWord(R.skills[i])} yet, and ${R.label} needs ${R.target[i]}/100.` : a ? `${R.skills[i]} is assessed at ${p.skills[i]}, and ${R.label} needs ${R.target[i]}.` : `You rated ${skillWord(R.skills[i])} at ${p.skills[i]}, and ${R.label} needs ${R.target[i]}.`;
      // Said to be the most asked-for only when it is: among the skills this student is short of, no other has more openings.
      const all = (ctx && ctx.demand && ctx.demand.bySkill) || [], short = R.skills.map((_, k) => k).filter((k) => k !== i && R.target[k] > ((p.skillsRated && !p.skillsRated[k] && !(p.skillsVerified && p.skillsVerified[k])) ? 0 : +p.skills[k]));
      const most = d && short.every((k) => (all[k] || 0) < d);
      return `${lead}${d ? ` It was asked for in ${plural(d, 'opening')} in the last 90 days${most && short.length ? ', more than any other skill you are short of' : ''}.` : ''}${{ direct: ` ${programme(p.prog).label} gives you the basics; a proctored course turns that into evidence.`, related: ` ${programme(p.prog).label} touches this only lightly, so a structured course fills the gap.`, switch: ` ${programme(p.prog).label} does not teach this, so a structured course is the quickest way in.`, open: '' }[fitOf(p)]}${a ? '' : ' Your own rating counts at half until your college assesses it.'}`; },
    because: (p, r, ctx) => { const i = focusSkill(p, ctx), d = ctx && ctx.demand && ctx.demand.bySkill ? ctx.demand.bySkill[i] || 0 : 0;
      return [`${ROLES[p.role].skills[i]}: ${skillState(p, i)} · target ${ROLES[p.role].target[i]}`, d ? `${plural(d, 'opening')} asking for it` : null, `${programme(p.prog).label} → ${ROLES[p.role].label}: ${pathOf(p)}`].filter(Boolean); },
  },
  demand: {
    // A skill employers asked for in their own words for this role. It is not one of the four scored skills, so it never changes the score.
    applies: (p, r, t, ctx) => !!(ctx && ctx.demand && ctx.demand.extra && ctx.demand.extra.length),
    sim: (p, ev) => [p, ev], noScore: true,
    assume: 'Does not change your score: it is not one of the four skills GRM scores for this role.',
    pick: (ctx) => ctx.demand.extra.find((k) => !k.have) || ctx.demand.extra[0],
    skillName: (p, ctx) => RULES.demand.pick(ctx).name,
    title: (p, r, ctx) => { const k = RULES.demand.pick(ctx); return k.have ? `Show employers your ${k.name}` : `Learn ${k.name}: employers are asking for it`; },
    what: (p, r, ctx) => { const k = RULES.demand.pick(ctx);
      return k.have ? `You listed ${k.name} as one of your skills. Add a certificate or a piece of work that shows it on Evidence, so your mentor can verify it and employers can trust it.` : `A short online course or a small piece of work that uses ${k.name} is enough to start. Then add it to your own skills on My score.`; },
    why: (p, r, t, ctx) => { const k = RULES.demand.pick(ctx); return `Openings for ${ROLES[p.role].label} asked for ${k.name} ${plural(k.openings, 'time')} in the last 90 days.`; },
    because: (p, r, ctx) => { const k = RULES.demand.pick(ctx); return [`${k.name}: asked for in ${plural(k.openings, 'opening')}`, k.have ? 'You listed it among your own skills' : 'Not among the skills you listed']; },
  },
  project: {
    applies: (p, r, t) => r.counts.project + r.waiting.project < t,
    sim: (p, ev) => [p, withEv(ev, 'project')],
    assume: 'Counts one more project in full, once your mentor has verified it.',
    title: (p, r, ctx) => { const it = interestsOf(ctx); return it.length ? `Do one applied project around ${lower(it[0])}` : 'Do one applied project'; },
    what: (p, r, ctx) => { const it = interestsOf(ctx), goal = ctx && ctx.words && ctx.words.goal;
      return `${ROLES[p.role].project}.${it.length ? ` Build it around what you wrote you care about (${listOf(it)}): you are more likely to finish a project you enjoy, and it gives you something real to talk about in interviews.` : ''}${goal ? ` Choose a question that moves you towards your goal: “${goal}”.` : ''}${{ direct: ` Use a method from your ${programme(p.prog).label} coursework so it shows you can apply what you study.`, related: ` Pick a topic where your ${programme(p.prog).label} background is an advantage.`, switch: ` For someone moving from ${programme(p.prog).label}, a finished project is the clearest proof you can do this work.`, open: '' }[fitOf(p)]} A dissertation counts too.`; },
    why: (p, r, t, ctx) => `Projects are part of academic excellence and carry 10% of your score. You have ${plural(r.counts.project, 'verified project')}, which gives ${Math.round(r.factors.projects)}/100. Each verified project adds 35.${peerLine(ctx, 'project') ? ' ' + peerLine(ctx, 'project') : ''}`,
    because: (p, r, ctx) => [plural(r.counts.project, 'verified project'), interestsOf(ctx).length ? `Your interests: ${listOf(interestsOf(ctx))}` : null, ctx && ctx.words && ctx.words.goal ? `Your goal: “${ctx.words.goal}”` : null, peerChip(ctx, 'project')].filter(Boolean),
  },
  internship: {
    applies: (p, r, t) => r.counts.internship + r.waiting.internship < t,
    sim: (p, ev) => [p, withEv(ev, 'internship')],
    assume: 'Counts one internship in full, once your mentor has verified it.',
    slot: (p, r, ctx) => (ctx && ctx.yearsLeft === 0 ? 'now' : null),
    title: (p, r, ctx) => (ctx && ctx.yearsLeft === 0 ? 'Line up an internship or placement before you graduate' : ctx && ctx.yearsLeft >= 2 && p.year === 1 ? 'Find a short first internship or job-shadowing this summer' : 'Line up a summer internship'),
    what: (p, r, ctx) => { const posts = (ctx && ctx.demand && ctx.demand.cityPosts) || [], cities = ctx && ctx.words && ctx.words.cities;
      return `Aim for ${ROLES[p.role].internship}. Start with your placement cell; the AICTE internship portal also lists openings for students.`
        + (posts.length ? ` ${listOf(posts.slice(0, 3).map((x) => `${x.employer} (${plural(x.openings, 'opening')} in ${x.city}${x.source ? `, from ${x.source}` : ''})`))} ${posts.length === 1 ? 'has' : 'have'} openings for ${ROLES[p.role].label} where you want to work.` : cities ? ` No openings for ${ROLES[p.role].label} in ${cities} are on GRM yet, so look more widely or ask your placement cell.` : '')
        + (fitOf(p) === 'switch' ? ` Coming from ${programme(p.prog).label}, say plainly in your application why you want ${ROLES[p.role].label} and point to your project or course.` : ''); },
    why: (p, r, t, ctx) => `Internships are part of academic excellence and carry 10% of your score. ${r.counts.internship === 0 ? 'You have no verified internships yet.' : `You are at ${Math.round(r.factors.internships)}/100.`}${ctx && ctx.yearsLeft === 0 ? ' You are in your final year, so this is the last chance to do one while still a student.' : ''}${peerLine(ctx, 'internship') ? ' ' + peerLine(ctx, 'internship') : ''}`,
    because: (p, r, ctx) => [plural(r.counts.internship, 'verified internship'), ctx && ctx.yearsLeft != null ? (ctx.yearsLeft === 0 ? 'Final year' : `${plural(ctx.yearsLeft, 'year')} left after this one`) : null, ctx && ctx.words && ctx.words.cities ? `Where you want to work: ${ctx.words.cities}` : null, peerChip(ctx, 'internship')].filter(Boolean),
  },
  transversal: {
    // The weakest of the five transversal skills, when it is below the threshold or not rated.
    applies: (p, r, t) => { const i = weakTransversal(p), v = (p.transversal || [])[i]; return !given(v) || +v < t; },
    sim: (p, ev) => { const q = clone(p), i = weakTransversal(q); q.transversal = (q.transversal || TRANSVERSAL.map(() => null)).slice(); q.transversalVerified = (q.transversalVerified || TRANSVERSAL.map(() => false)).slice();
      q.transversal[i] = given(q.transversal[i]) ? Math.min(100, +q.transversal[i] + 12) : 50; q.transversalVerified[i] = true; return [q, ev]; },
    assume: (p) => { const i = weakTransversal(p); return given((p.transversal || [])[i]) ? 'Assumes a 12-point gain and that your mentor then assesses it at that level.' : 'Assumes you reach 50/100 and your mentor assesses it at that level.'; },
    tskill: (p) => weakTransversal(p),
    title: (p) => `Build your ${lower(TRANSVERSAL[weakTransversal(p)])}`,
    what: (p, r, ctx) => { const i = weakTransversal(p), it = interestsOf(ctx);
      return `${TRANSVERSAL_PRACTICE[i]}. Then ask your mentor to assess it.${it.length ? ` Doing it around something you care about (${lower(it[0])}) makes it easier to keep going.` : ''}`; },
    why: (p, r) => { const i = weakTransversal(p); return `Transversal skills carry 20% of your score, and every job needs them. ${TRANSVERSAL[i]} is the lowest of your five: ${tvState(p, i)}.`; },
    because: (p) => { const i = weakTransversal(p); return [`${TRANSVERSAL[i]}: ${tvState(p, i)}`]; },
  },
  academic: {
    applies: (p, r, t) => r.factors.cgpa !== null && +p.cgpa < t,
    sim: (p, ev) => { const q = clone(p); q.cgpa = Math.min(10, +q.cgpa + 0.5); return [q, ev]; },
    assume: 'Assumes your CGPA rises by 0.5 and your mentor confirms the new figure.',
    title: (p, r, ctx) => (ctx && ctx.yearsLeft === 0 ? 'Protect your CGPA in your final semesters' : 'Lift your CGPA by half a point'),
    what: (p, r, ctx) => `Use tutorial hours for your two weakest papers and plan revision a month before end-semester exams.${ctx && ctx.yearsLeft === 0 ? ' Many employers screen on final CGPA, and there are few semesters left to move it.' : ''}`,
    why: (p, r) => `Your CGPA carries 15% of your score, the largest single part, because employers judge new graduates on their discipline first. ${p.cgpaConfirmed ? 'Your confirmed' : 'Your'} CGPA of ${p.cgpa} gives ${Math.round(r.factors.cgpa)}/100${p.cgpaConfirmed ? '' : ' while it counts at half'}.`,
    because: (p, r, ctx) => [`${p.cgpaConfirmed ? 'Confirmed' : 'Your own'} CGPA ${p.cgpa}`, ctx && ctx.yearsLeft === 0 ? 'Final year' : null].filter(Boolean),
  },
  cocurricular: {
    applies: (p, r) => r.counts.role + r.waiting.role === 0,
    sim: (p, ev) => [p, withEv(ev, 'role')],
    assume: 'Moves co-curricular achievements from 0 to 50, once your mentor has verified it.',
    title: () => 'Do one thing beyond your course',
    what: (p, r, ctx) => { const it = interestsOf(ctx); return `Enter a hackathon or competition, join NSS or NCC, take a club or committee role, or volunteer.${it.length ? ` Pick something linked to what you wrote you enjoy (${listOf(it)}).` : ''} Then add it on Evidence.`; },
    why: (p, r, t, ctx) => `Co-curricular achievements carry 10% of your score. What you do outside your course often shows employers the most about you, and it can become your profession.${peerLine(ctx, 'role') ? ' ' + peerLine(ctx, 'role') : ''}`,
    because: (p, r, ctx) => ['No co-curricular achievement on record', interestsOf(ctx).length ? `Your interests: ${listOf(interestsOf(ctx))}` : null, peerChip(ctx, 'role')].filter(Boolean),
  },
  questionnaire: {
    // The questionnaire result cannot be predicted, so no gain is projected.
    applies: (p, r, t, ctx) => r.flags.psychometricMissing && !(ctx && ctx.psyConsent === false),
    sim: (p, ev) => [p, ev], noScore: true,
    assume: 'Not projected: your answers decide the result. Social-emotional carries 10% of your score.',
    title: () => 'Answer the 20-question personality questionnaire',
    what: () => 'It is on My score and takes about three minutes. There are no right answers: describe yourself as you are now, not as you wish to be.',
    why: () => 'Social-emotional carries 10% of your score and is left out until you answer. Only conscientiousness and emotional stability count; your full profile is shown only to you.',
    because: () => ['Personality questionnaire: not answered yet'],
  },
  goal: {
    // What the student wrote they want points to a different kind of work from their aspired role.
    applies: (p, r, t, ctx) => !!(ctx && ctx.goal && ctx.goal.family !== 'general' && ctx.goal.family !== (ROLES[p.role] || {}).family),
    sim: (p, ev) => [p, ev], noScore: true,
    assume: 'Does not change your score. It decides what every other step aims at.',
    title: () => 'Check your aspired role against your goal',
    what: (p, r, ctx) => `You wrote “${ctx.goal.text}”. That sounds closer to ${ctx.goal.roleLabel} than to ${ROLES[p.role].label}. Add it as another role you are considering on My score to see how you match, then decide which to make your main one.`,
    why: () => 'Every other step here is built around your main aspired role. If your real aim is elsewhere, they are aimed at the wrong thing.',
    because: (p, r, ctx) => [`Your goal: “${ctx.goal.text}”`, `Your aspired role: ${ROLES[p.role].label}`],
  },
  clarity: {
    applies: (p, r, t) => r.factors.clarity !== null && r.factors.clarity < t,
    sim: (p, ev) => { const q = clone(p); q.clarity = Math.min(100, (+q.clarity || 0) + 20); return [q, ev]; },
    assume: 'Assumes your confidence rating rises by 20.',
    title: () => 'Test your career direction',
    what: (p, r, ctx) => `${ctx && ctx.words && !ctx.words.goal ? 'Start by writing your goal in your own words on My score. Then shortlist' : 'Shortlist'} two roles, including ${ROLES[p.role].label}, and talk to one working person in each${fitOf(p) === 'switch' ? `, ideally someone who also moved into it from ${programme(p.prog).label}` : ''}. Then re-rate your confidence.`,
    why: (p, r) => `You rated your career confidence ${Math.round(r.factors.clarity)}/100. It carries only 5% of your score, but it sharpens every other step in the plan.`,
    because: (p, r) => [`Career confidence: ${Math.round(r.factors.clarity)}`],
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
  { id: 'confirm', factor: 'cgpa', slot: 'now', effort: 'One meeting with your mentor', threshold: null },
  { id: 'proof', factor: 'projects', slot: 'now', effort: 'A few minutes', threshold: null },
  { id: 'course', factor: 'technical', slot: 'now', effort: '6–8 weeks, about 3 hours a week', threshold: 60 },
  { id: 'demand', factor: 'technical', slot: 'next', effort: '2–6 weeks', threshold: null },
  { id: 'project', factor: 'projects', slot: 'next', effort: 'One semester', threshold: 3 },
  { id: 'internship', factor: 'internships', slot: 'summer', effort: '6–8 weeks over summer', threshold: 2 },
  { id: 'transversal', factor: 'transversal', slot: 'next', effort: 'One semester of practice', threshold: 70 },
  { id: 'academic', factor: 'cgpa', slot: 'next', effort: 'Through end-semester exams', threshold: 8.5 },
  { id: 'cocurricular', factor: 'cocurricular', slot: 'next', effort: 'A few hours a week', threshold: null },
  { id: 'questionnaire', factor: 'socioemotional', slot: 'now', effort: 'About three minutes', threshold: null },
  { id: 'goal', factor: 'clarity', slot: 'now', effort: 'One conversation', threshold: null },
  { id: 'clarity', factor: 'clarity', slot: 'winter', effort: '3–4 conversations over the break', threshold: 75 },
  { id: 'counsellor', factor: 'clarity', slot: 'now', effort: 'One conversation', threshold: 40 },
];
// Rules from earlier formula versions, replaced in v0.4 (communication → transversal, leadership → co-curricular).
const RETIRED_RULES = ['communication', 'leadership'];

// Allowed threshold range per rule, so an admin cannot switch a rule off by typing a nonsense value.
const THRESHOLD_RANGE = { course: [0, 100], project: [0, 10], internship: [0, 10], transversal: [0, 100], academic: [0, 10], clarity: [0, 100], counsellor: [0, 100] };

/** Steps for this student, built from their own data (see ctx above). Order: what to do first (confirmation, proof the
 *  mentor asked for), then up to 5 steps that raise the score, largest gain first, then steps that matter to this
 *  student but do not change the score, then the counsellor. */
function recommend(p, evidence, settings, ctx) {
  ctx = ctx || {};
  const r = score(p, evidence), here = band(r.index);
  const out = [];
  for (const s of settings) {
    const rule = RULES[s.id];
    if (!rule || !s.active || !rule.applies(p, r, s.threshold, ctx, evidence)) continue;
    const [q, ev] = rule.sim(p, evidence, ctx);
    const gain = rule.noScore ? 0 : round1(score(q, ev).index - r.index);
    if (gain <= 0.05 && !rule.always && !rule.noScore) continue;
    let slot = (rule.slot && rule.slot(p, r, ctx)) || s.slot;
    if (ctx.yearsLeft === 0 && slot === 'summer') slot = 'next'; // no summer as a student is left
    const next = band(r.index + gain);
    out.push({ id: s.id, factor: rule.factor ? rule.factor(p, r, ctx, evidence) : s.factor, slot, effort: s.effort, gain, always: !!rule.always, first: !!rule.first, personal: !!rule.noScore,
      title: rule.title(p, r, ctx, evidence), what: rule.what(p, r, ctx, evidence), why: rule.why(p, r, s.threshold, ctx, evidence), assume: typeof rule.assume === 'function' ? rule.assume(p, ctx) : rule.assume,
      because: rule.because ? rule.because(p, r, ctx, evidence) : [],
      crosses: next.k !== here.k ? `This alone moves you from ${here.label} to ${next.label}.` : null,
      skillIndex: rule.skill ? rule.skill(p, ctx) : null, skillName: rule.skillName ? rule.skillName(p, ctx) : null, tskill: rule.tskill ? rule.tskill(p) : null });
  }
  // Proof the mentor asked for is done before anything new.
  const urgent = (x) => x.first || (x.id === 'proof' && /^Add proof/.test(x.title));
  const ranked = out.filter((x) => !x.always && !x.personal && !urgent(x)).sort((a, b) => b.gain - a.gain), scored = ranked.slice(0, 5);
  // The step on the role's own skills is kept even when it would fall below the cut: those skills are what the role needs.
  const course = ranked.find((x) => x.id === 'course'); if (course && !scored.includes(course)) scored.push(course);
  return out.filter(urgent).concat(scored, out.filter((x) => x.personal), out.filter((x) => x.always && !x.first));
}

/** Score after completing the given accepted rules, applied in turn. */
function projectIndex(p, evidence, ruleIds, ctx) {
  let q = clone(p), ev = evidence.slice();
  for (const id of ruleIds) { const rule = RULES[id]; if (rule && !rule.noScore) { [q, ev] = rule.sim(q, ev, ctx || {}); } }
  return score(q, ev).index;
}

module.exports = { SECTORS, SESSION_KINDS, SOURCE_KINDS, pathNote, fitOf, programme, BUILT_IN_ROLES, BUILT_IN_PROGRAMMES, projectIndex, FORMULA_VERSION, MIN_GROUP, HALF, FACTORS, GROUPS, TRANSVERSAL, IPIP, IPIP_SCALE, TRAIT_NAMES, ipipTraits, ROLES, PROGRAMMES, EVIDENCE_TYPES, SLOTS, CONSENT_PURPOSES,
  DEFAULT_RULE_SETTINGS, RETIRED_RULES, THRESHOLD_RANGE, weakest, weakTransversal, focusSkill, score, band, recommend, counts, avg, round1, clamp };
