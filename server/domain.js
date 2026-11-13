// Reference data, the scoring formula and the recommendation rules.
// The score is pure arithmetic. Nothing in this file calls an AI model.

const L = require('./library');

const FORMULA_VERSION = 'v0.3';
const MIN_GROUP = 5; // aggregates for groups smaller than this are suppressed

const FACTORS = [
  { k: 'academic', label: 'Academic', w: 20, how: 'CGPA × 10, once your mentor has confirmed your CGPA against college records. Not yet rated until then.' },
  { k: 'technical', label: 'Technical / role skills', w: 20, how: 'Average of your four role skills, where a skill counts only once your college has assessed it and a skill not yet assessed counts as 0. Plus 3 per verified certificate and 1.5 per verified NPTEL/SWAYAM course. Capped at 100. Your own ratings guide your plan but do not count.' },
  { k: 'projects', label: 'Projects', w: 15, how: '35 for each project your mentor has verified, capped at 100. None verified scores 0.' },
  { k: 'experience', label: 'Experience', w: 15, how: '50 for each internship your mentor has verified, capped at 100. None verified scores 0.' },
  { k: 'psychometric', label: 'Psychometric', w: 10, how: 'Average of the five personality traits you entered, with neuroticism reversed (100 − neuroticism). Not yet rated until you enter all five.' },
  { k: 'communication', label: 'Communication', w: 10, how: 'Your college communication assessment, recorded by your mentor. Not yet rated until then.' },
  { k: 'leadership', label: 'Leadership', w: 5, how: '50 for each verified NSS, NCC, club or committee role, capped at 100. None verified scores 0.' },
  { k: 'clarity', label: 'Career clarity', w: 5, how: 'Your own rating of how sure you are about your career direction. Not yet rated until you give one.' },
];

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
    open: `Your plan is built around ${R.label} and ${P.label} as you typed them. ${R.needsReview ? 'This role is new to NGRM, so it starts with general workplace skills until the NGRM admin sets the specific ones.' : 'Ask your mentor how others have made this move.'}`,
  }[f];
  return { fit: f, label: L.FIT_LABEL[f], text };
}

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
// Formula v0.3.
// 0. Nothing the student types in about their own marks or skills counts until it is confirmed: CGPA by a mentor
//    against college records, each role skill by a college assessment.
// 1. Only evidence a mentor has verified counts.
// 2. A factor the student has not answered is "not yet rated" (null): it is left out, and the score is the
//    weighted average of the rated factors. `completeness` says how much of the full formula that covers.
// 3. Projects, experience and leadership start at 0 and rise with each verified item.
function score(p, evidence) {
  const c = counts(evidence);
  const f = {};
  f.academic = given(p.cgpa) && p.cgpaConfirmed ? clamp(+p.cgpa * 10) : null;
  const assessed = (p.skills || []).filter((s, i) => p.skillsVerified && p.skillsVerified[i]).map(Number).filter((n) => !Number.isNaN(n));
  // Averaged over all the role's skills, so each new assessment can only add; being assessed in a weak skill never lowers the score.
  f.technical = Math.min(100, assessed.reduce((x, y) => x + y, 0) / Math.max(1, (p.skills || []).length) + c.certificate * 3 + c.course * 1.5);
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
    skillsAssessed: assessed.length,
    flags: { cgpaMissing: !given(p.cgpa), cgpaUnconfirmed: given(p.cgpa) && !p.cgpaConfirmed, skillsUnassessed: (p.skills || []).length - assessed.length, commUnrated: f.communication === null, psychometricMissing: !o, clarityMissing: !given(p.clarity) } };
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

const TYPE_FACTOR = { internship: 'experience', project: 'projects', course: 'technical', certificate: 'technical', role: 'leadership' };
const TYPE_NAME = { internship: 'internship', project: 'project', course: 'course', certificate: 'certificate', role: 'responsibility role' };
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
  return `your own rating ${p.skills[i]}`;
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

const RULES = {
  confirm: {
    applies: (p, r) => r.flags.cgpaUnconfirmed || r.flags.skillsUnassessed > 0,
    // No gain is projected: the result depends on what the college finds, which may be higher or lower than the student's own figures.
    sim: (p, ev) => [p, ev],
    assume: 'Not projected. Your score changes by whatever your college confirms.',
    always: true, first: true,
    title: (p, r) => (r.flags.cgpaUnconfirmed && r.flags.skillsUnassessed ? 'Get your CGPA confirmed and your skills assessed' : r.flags.cgpaUnconfirmed ? 'Get your CGPA confirmed' : 'Get your remaining skills assessed'),
    what: (p, r) => [r.flags.cgpaUnconfirmed ? `Show your mentor your latest marks card so they can confirm your CGPA of ${p.cgpa}.` : '', r.flags.skillsUnassessed ? `Ask when the college assessment runs for ${listOf(p.skills.map((s, i) => (p.skillsVerified && p.skillsVerified[i] ? null : skillWord(ROLES[p.role].skills[i]))).filter(Boolean))}.` : ''].filter(Boolean).join(' '),
    why: (p, r) => `What you enter about yourself does not count until your college confirms it. ${r.flags.cgpaUnconfirmed ? 'Your CGPA is waiting for confirmation, so the academic 20% is left out of your score. ' : ''}${r.flags.skillsUnassessed ? `${r.skillsAssessed} of your ${p.skills.length} role skills ${r.skillsAssessed === 1 ? 'has' : 'have'} been assessed; a skill not yet assessed counts as 0 towards the technical 20%.` : ''}`.trim(),
    because: (p, r) => [r.flags.cgpaUnconfirmed ? `CGPA ${p.cgpa}, waiting for confirmation` : null].concat(ROLES[p.role].skills.map((k, i) => (p.skillsVerified && p.skillsVerified[i] ? null : `${k}: ${skillState(p, i)}`))).filter(Boolean),
  },
  proof: {
    applies: (p, r, t, ctx, ev) => !!proofPick(p, ev),
    sim: (p, ev) => { const x = proofPick(p, ev); return x ? [p, ev.map((e, k) => (k === x.k ? { ...e, status: 'verified' } : e))] : [p, ev]; },
    assume: 'Counts this item once your mentor has verified it.',
    factor: (p, r, ctx, ev) => TYPE_FACTOR[proofPick(p, ev).e.type],
    title: (p, r, ctx, ev) => { const x = proofPick(p, ev); return x.e.status === 'needs_proof' ? `Add proof for “${x.e.title}”` : `Get “${x.e.title}” verified`; },
    what: (p, r, ctx, ev) => { const x = proofPick(p, ev);
      return (x.e.status === 'needs_proof' ? 'Your mentor asked for proof before they can verify it. On Evidence, upload the certificate, offer letter or report (PDF, PNG or JPEG, up to 5 MB).' : `Your ${TYPE_NAME[x.e.type]} is waiting for your mentor.${x.e.has_file ? '' : ' Uploading the certificate or letter on Evidence makes it quicker to verify.'} Mention it at your next meeting.`)
        + (x.others ? ` You have ${plural(x.others, 'other item')} waiting too.` : ''); },
    why: (p, r, t, ctx, ev) => { const x = proofPick(p, ev), f = FACTORS.find((k) => k.k === TYPE_FACTOR[x.e.type]); return `You have already done this; it just is not counted yet. ${f ? `${f.label} carries ${f.w}% of your score, and` : 'It'} unverified evidence counts for nothing.`; },
    because: (p, r, ctx, ev) => { const x = proofPick(p, ev); return [`“${x.e.title}”: ${x.e.status === 'needs_proof' ? 'your mentor asked for proof' : 'waiting for your mentor'}`]; },
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
      return `${lead}${d ? ` Employers on NGRM asked for it in ${plural(d, 'opening')} in the last 90 days${most && short.length ? ', more than any other skill you are short of' : ''}.` : ''}${{ direct: ` ${programme(p.prog).label} gives you the basics; a proctored course turns that into evidence.`, related: ` ${programme(p.prog).label} touches this only lightly, so a structured course fills the gap.`, switch: ` ${programme(p.prog).label} does not teach this, so a structured course is the quickest way in.`, open: '' }[fitOf(p)]}${a ? '' : ' It starts counting once your college assesses it.'}`; },
    because: (p, r, ctx) => { const i = focusSkill(p, ctx), d = ctx && ctx.demand && ctx.demand.bySkill ? ctx.demand.bySkill[i] || 0 : 0;
      return [`${ROLES[p.role].skills[i]}: ${skillState(p, i)} · target ${ROLES[p.role].target[i]}`, d ? `${plural(d, 'opening')} asking for it` : null, `${programme(p.prog).label} → ${ROLES[p.role].label}: ${pathOf(p)}`].filter(Boolean); },
  },
  demand: {
    // A skill employers typed in their own words for this role. It is not one of the four scored skills, so it never changes the score.
    applies: (p, r, t, ctx) => !!(ctx && ctx.demand && ctx.demand.extra && ctx.demand.extra.length),
    sim: (p, ev) => [p, ev], noScore: true,
    assume: 'Does not change your score: it is not one of the four skills NGRM scores for this role.',
    pick: (ctx) => ctx.demand.extra.find((k) => !k.have) || ctx.demand.extra[0],
    skillName: (p, ctx) => RULES.demand.pick(ctx).name,
    title: (p, r, ctx) => { const k = RULES.demand.pick(ctx); return k.have ? `Show employers your ${k.name}` : `Learn ${k.name}: employers are asking for it`; },
    what: (p, r, ctx) => { const k = RULES.demand.pick(ctx);
      return k.have ? `You listed ${k.name} as one of your skills. Add a certificate or a piece of work that shows it on Evidence, so your mentor can verify it and employers can trust it.` : `A short online course or a small piece of work that uses ${k.name} is enough to start. Then add it to your own skills on My score.`; },
    why: (p, r, t, ctx) => { const k = RULES.demand.pick(ctx); return `Employers posting for ${ROLES[p.role].label} on NGRM wrote that they need ${k.name}, in ${plural(k.openings, 'opening')} over the last 90 days.`; },
    because: (p, r, ctx) => { const k = RULES.demand.pick(ctx); return [`${k.name}: asked for in ${plural(k.openings, 'opening')}`, k.have ? 'You listed it among your own skills' : 'Not among the skills you listed']; },
  },
  project: {
    applies: (p, r, t) => r.counts.project < t,
    sim: (p, ev) => [p, withEv(ev, 'project')],
    assume: 'Counts one more project, once your mentor has verified it.',
    title: (p, r, ctx) => { const it = interestsOf(ctx); return it.length ? `Do one applied project around ${lower(it[0])}` : 'Do one applied project'; },
    what: (p, r, ctx) => { const it = interestsOf(ctx), goal = ctx && ctx.words && ctx.words.goal;
      return `${ROLES[p.role].project}.${it.length ? ` Build it around what you wrote you care about (${listOf(it)}): you are more likely to finish a project you enjoy, and it gives you something real to talk about in interviews.` : ''}${goal ? ` Choose a question that moves you towards your goal: “${goal}”.` : ''}${{ direct: ` Use a method from your ${programme(p.prog).label} coursework so it shows you can apply what you study.`, related: ` Pick a topic where your ${programme(p.prog).label} background is an advantage.`, switch: ` For someone moving from ${programme(p.prog).label}, a finished project is the clearest proof you can do this work.`, open: '' }[fitOf(p)]}`; },
    why: (p, r, t, ctx) => `Projects carry 15% of your score. You have ${plural(r.counts.project, 'verified project')}, which gives ${Math.round(r.factors.projects)}/100. Each verified project adds 35.${peerLine(ctx, 'project') ? ' ' + peerLine(ctx, 'project') : ''}`,
    because: (p, r, ctx) => [plural(r.counts.project, 'verified project'), interestsOf(ctx).length ? `Your interests: ${listOf(interestsOf(ctx))}` : null, ctx && ctx.words && ctx.words.goal ? `Your goal: “${ctx.words.goal}”` : null, peerChip(ctx, 'project')].filter(Boolean),
  },
  internship: {
    applies: (p, r, t) => r.counts.internship < t,
    sim: (p, ev) => [p, withEv(ev, 'internship')],
    assume: 'Counts one internship, once your mentor has verified it.',
    slot: (p, r, ctx) => (ctx && ctx.yearsLeft === 0 ? 'now' : null),
    title: (p, r, ctx) => (ctx && ctx.yearsLeft === 0 ? 'Line up an internship or placement before you graduate' : ctx && ctx.yearsLeft >= 2 && p.year === 1 ? 'Find a short first internship or job-shadowing this summer' : 'Line up a summer internship'),
    what: (p, r, ctx) => { const posts = (ctx && ctx.demand && ctx.demand.cityPosts) || [], cities = ctx && ctx.words && ctx.words.cities;
      return `Aim for ${ROLES[p.role].internship}. Start with your placement cell; the AICTE internship portal also lists openings for students.`
        + (posts.length ? ` On NGRM, ${listOf(posts.slice(0, 3).map((x) => `${x.employer} (${plural(x.openings, 'opening')} in ${x.city})`))} ${posts.length === 1 ? 'has' : 'have'} posted for ${ROLES[p.role].label} where you want to work. Ask your placement cell for an introduction.` : cities ? ` No employer on NGRM has posted for ${ROLES[p.role].label} in ${cities} yet, so look more widely or ask your placement cell.` : '')
        + (fitOf(p) === 'switch' ? ` Coming from ${programme(p.prog).label}, say plainly in your application why you want ${ROLES[p.role].label} and point to your project or course.` : ''); },
    why: (p, r, t, ctx) => `Experience carries 15% of your score. ${r.counts.internship === 0 ? 'You have no verified internships yet, so this factor is at 0.' : `You are at ${Math.round(r.factors.experience)}/100.`}${ctx && ctx.yearsLeft === 0 ? ' You are in your final year, so this is the last chance to do one while still a student.' : ''}${peerLine(ctx, 'internship') ? ' ' + peerLine(ctx, 'internship') : ''}`,
    because: (p, r, ctx) => [plural(r.counts.internship, 'verified internship'), ctx && ctx.yearsLeft != null ? (ctx.yearsLeft === 0 ? 'Final year' : `${plural(ctx.yearsLeft, 'year')} left after this one`) : null, ctx && ctx.words && ctx.words.cities ? `Where you want to work: ${ctx.words.cities}` : null, peerChip(ctx, 'internship')].filter(Boolean),
  },
  communication: {
    // Shown when the student has not been assessed, or was assessed below the threshold.
    applies: (p, r, t) => r.factors.communication === null || r.factors.communication < t,
    sim: (p, ev) => { if (!given(p.comm)) return [p, ev]; const q = clone(p); q.comm = Math.round(Math.min(100, +p.comm + 12)); return [q, ev]; },
    assume: 'Assumes a 12-point gain at your next assessment. No points are projected until you have been assessed once.',
    title: (p) => (given(p.comm) ? 'Practise speaking, then get re-assessed' : 'Take the college communication assessment'),
    what: (p, r, ctx) => { const it = interestsOf(ctx);
      return (given(p.comm) ? 'Join a debate, theatre or public-speaking club for a semester, then ask your mentor for a fresh communication assessment.' : 'Ask your mentor when the college communication assessment runs. A debate, theatre or public-speaking club is good practice beforehand.')
        + (it.length ? ` Speaking about something you know well helps: try a short talk on ${lower(it[0])}.` : ''); },
    why: (p, r) => (r.flags.commUnrated ? 'Communication carries 10% of the score, but yours has not been assessed yet, so it is left out of your total for now.' : `Your assessed communication score is ${Math.round(r.factors.communication)}/100. It carries 10% of your score.`),
    because: (p, r) => [r.flags.commUnrated ? 'Communication: not assessed yet' : `Communication: assessed at ${Math.round(r.factors.communication)}`],
  },
  academic: {
    applies: (p, r, t) => r.factors.academic !== null && +p.cgpa < t,
    sim: (p, ev) => { const q = clone(p); q.cgpa = Math.min(10, +q.cgpa + 0.5); return [q, ev]; },
    assume: 'Assumes your CGPA rises by 0.5 and your mentor confirms the new figure.',
    title: (p, r, ctx) => (ctx && ctx.yearsLeft === 0 ? 'Protect your CGPA in your final semesters' : 'Lift your CGPA by half a point'),
    what: (p, r, ctx) => `Use tutorial hours for your two weakest papers and plan revision a month before end-semester exams.${ctx && ctx.yearsLeft === 0 ? ' Many employers screen on final CGPA, and there are few semesters left to move it.' : ''}`,
    why: (p, r) => `Academic performance carries 20% of your score. Your confirmed CGPA of ${p.cgpa} gives ${Math.round(r.factors.academic)}/100.`,
    because: (p, r, ctx) => [`Confirmed CGPA ${p.cgpa}`, ctx && ctx.yearsLeft === 0 ? 'Final year' : null].filter(Boolean),
  },
  leadership: {
    applies: (p, r) => r.counts.role === 0,
    sim: (p, ev) => [p, withEv(ev, 'role')],
    assume: 'Moves leadership from 0 to 50, once your mentor has verified the role.',
    title: () => 'Take on a responsibility role',
    what: (p, r, ctx) => { const it = interestsOf(ctx); return it.length ? `Lead something linked to what you wrote you enjoy (${listOf(it)}): run a club event, start a study circle, or coordinate a college activity. NSS and NCC count too.` : 'Volunteer with NSS or NCC, or lead a club event or a student committee this year.'; },
    why: (p, r, t, ctx) => `Leadership carries 5% of your score. With no verified role on record it is at 0; one role moves it to 50.${peerLine(ctx, 'role') ? ' ' + peerLine(ctx, 'role') : ''}`,
    because: (p, r, ctx) => ['No verified responsibility role', interestsOf(ctx).length ? `Your interests: ${listOf(interestsOf(ctx))}` : null, peerChip(ctx, 'role')].filter(Boolean),
  },
  goal: {
    // What the student wrote they want points to a different kind of work from their target role.
    applies: (p, r, t, ctx) => !!(ctx && ctx.goal && ctx.goal.family !== 'general' && ctx.goal.family !== (ROLES[p.role] || {}).family),
    sim: (p, ev) => [p, ev], noScore: true,
    assume: 'Does not change your score. It decides what every other step aims at.',
    title: () => 'Check your target role against your goal',
    what: (p, r, ctx) => `You wrote “${ctx.goal.text}”. That sounds closer to ${ctx.goal.roleLabel} than to ${ROLES[p.role].label}. Talk it over with your mentor, then either change your target role on My score or keep it and write down why.`,
    why: () => 'Every other step here is built around your target role. If your real aim is elsewhere, they are aimed at the wrong thing.',
    because: (p, r, ctx) => [`Your goal: “${ctx.goal.text}”`, `Your target role: ${ROLES[p.role].label}`],
  },
  clarity: {
    applies: (p, r, t) => r.factors.clarity !== null && r.factors.clarity < t,
    sim: (p, ev) => { const q = clone(p); q.clarity = Math.min(100, (+q.clarity || 0) + 20); return [q, ev]; },
    assume: 'Assumes your confidence rating rises by 20.',
    title: () => 'Test your career direction',
    what: (p, r, ctx) => `${ctx && ctx.words && !ctx.words.goal ? 'Start by writing your goal in your own words on My score. Then shortlist' : 'Shortlist'} two roles, including ${ROLES[p.role].label}, and talk to one working person in each${fitOf(p) === 'switch' ? `, ideally someone who also moved into it from ${programme(p.prog).label}` : ''}. Then re-rate your confidence with your mentor.`,
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
  { id: 'confirm', factor: 'academic', slot: 'now', effort: 'One meeting with your mentor', threshold: null },
  { id: 'proof', factor: 'projects', slot: 'now', effort: 'A few minutes', threshold: null },
  { id: 'course', factor: 'technical', slot: 'now', effort: '6–8 weeks, about 3 hours a week', threshold: 60 },
  { id: 'demand', factor: 'technical', slot: 'next', effort: '2–6 weeks', threshold: null },
  { id: 'project', factor: 'projects', slot: 'next', effort: 'One semester', threshold: 3 },
  { id: 'internship', factor: 'experience', slot: 'summer', effort: '6–8 weeks over summer', threshold: 2 },
  { id: 'communication', factor: 'communication', slot: 'next', effort: 'One semester of practice', threshold: 85 },
  { id: 'academic', factor: 'academic', slot: 'next', effort: 'Through end-semester exams', threshold: 8.5 },
  { id: 'leadership', factor: 'leadership', slot: 'next', effort: 'A few hours a week', threshold: null },
  { id: 'goal', factor: 'clarity', slot: 'now', effort: 'One conversation', threshold: null },
  { id: 'clarity', factor: 'clarity', slot: 'winter', effort: '3–4 conversations over the break', threshold: 75 },
  { id: 'counsellor', factor: 'clarity', slot: 'now', effort: 'One conversation', threshold: 40 },
];

// Allowed threshold range per rule, so an admin cannot switch a rule off by typing a nonsense value.
const THRESHOLD_RANGE = { course: [0, 100], project: [0, 10], internship: [0, 10], communication: [0, 100], academic: [0, 10], clarity: [0, 100], counsellor: [0, 100] };

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
      skillIndex: rule.skill ? rule.skill(p, ctx) : null, skillName: rule.skillName ? rule.skillName(p, ctx) : null });
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

module.exports = { pathNote, fitOf, programme, BUILT_IN_ROLES, BUILT_IN_PROGRAMMES, projectIndex, FORMULA_VERSION, MIN_GROUP, FACTORS, ROLES, PROGRAMMES, EVIDENCE_TYPES, SLOTS, CONSENT_PURPOSES,
  DEFAULT_RULE_SETTINGS, THRESHOLD_RANGE, weakest, focusSkill, score, band, recommend, counts, avg, round1, clamp };
