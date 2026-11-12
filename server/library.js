// Typed target roles and programmes.
// A student, employer or admin can type any role or programme. Nothing here calls an AI model: a typed role is matched
// to a role family by keywords and takes that family's four skills; a typed programme is matched to a discipline.
// The family and discipline together decide how the plan is worded (direct path, related path or career switch).
// An admin can then correct the skills of any typed role.

// Each family: default role name, keywords (longer matches win), four skills with target levels,
// a project idea and an internship phrase. {role} is replaced with the role as typed.
const FAMILIES = [
  { k: 'software', name: 'Software Developer', kw: ['software', 'developer', 'programmer', 'sde', 'full stack', 'fullstack', 'backend', 'back end', 'frontend', 'front end', 'web developer', 'app developer', 'android', 'ios developer', 'devops', 'cloud engineer', 'software engineer', 'coder', 'java', 'qa engineer', 'tester', 'test engineer'],
    skills: ['Data structures and algorithms', 'Git', 'Web development', 'Databases'], target: [70, 65, 70, 65],
    project: 'Build and deploy a small app that fixes a real campus problem', internship: 'a software development internship' },
  { k: 'data', name: 'Data Analyst', kw: ['data analyst', '~data', 'analytics', 'data engineer', 'business intelligence', 'mis executive', 'mis analyst', 'statistician', 'reporting analyst'],
    skills: ['SQL', 'Python', 'Statistics', 'Data visualisation'], target: [70, 65, 70, 65],
    project: 'Analyse an open dataset from data.gov.in and publish a short dashboard', internship: 'a data or MIS internship' },
  { k: 'ai', name: 'Machine Learning Engineer', kw: ['machine learning', 'ml engineer', 'artificial intelligence', 'ai engineer', 'data scientist', 'data science', 'deep learning', 'nlp', 'computer vision', 'ai researcher'],
    skills: ['Python', 'Statistics and probability', 'Machine learning basics', 'Data handling with SQL'], target: [70, 70, 65, 65],
    project: 'Train and evaluate a small model on an open dataset and write up what it gets wrong', internship: 'a data science or machine learning internship' },
  { k: 'cyber', name: 'Cybersecurity Analyst', kw: ['cyber', 'security', 'security analyst', 'information security', 'infosec', 'ethical hacker', 'penetration', 'soc analyst', 'network engineer', 'network administrator', 'system administrator'],
    skills: ['Networking basics', 'Operating systems and Linux', 'Security fundamentals', 'Scripting'], target: [70, 65, 70, 60],
    project: 'Set up a small home lab, find and fix five common weaknesses, and document each one', internship: 'an IT security or network operations internship' },
  { k: 'ux', name: 'UX Researcher', kw: ['ux', 'ux researcher', 'user experience', 'user research', 'user researcher', 'usability', 'design researcher'],
    skills: ['User interviews', 'Survey design', 'Usability testing', 'Figma basics'], target: [70, 70, 70, 60],
    project: 'Run a usability study on a public-service app and write it up as a case study', internship: 'a UX research internship with a product team' },
  { k: 'design', name: 'Graphic Designer', kw: ['designer', 'graphic', 'visual design', 'ui design', 'ui designer', 'illustrator', 'animator', 'animation', 'motion graphics', 'product designer'],
    skills: ['Design principles', 'Figma or Adobe tools', 'Typography and layout', 'Portfolio presentation'], target: [70, 70, 65, 70],
    project: 'Redesign the identity or materials of a local organisation and show the before and after', internship: 'a design internship with a studio or product team' },
  { k: 'product', name: 'Product Manager', kw: ['product manager', 'product management', 'product owner', 'product analyst', 'program manager', 'project manager', 'project coordinator', 'scrum master'],
    skills: ['User and market research', 'Writing product requirements', 'Data analysis for decisions', 'Stakeholder communication'], target: [70, 65, 65, 70],
    project: 'Pick a product you use, interview ten users, and write a one-page proposal for one improvement', internship: 'a product or project management internship' },
  { k: 'marketing', name: 'Marketing Associate', kw: ['marketing', 'brand', 'digital marketing', 'seo', 'growth', 'advertising', 'social media manager', 'public relations', 'market research'],
    skills: ['Market research', 'Digital marketing', 'Excel', 'Presentation'], target: [65, 65, 65, 70],
    project: 'Run a market survey for a local business and pitch your recommendations', internship: 'a marketing internship' },
  { k: 'sales', name: 'Sales Associate', kw: ['sales', 'business development', 'account manager', 'account executive', 'relationship manager', 'inside sales', 'retail', 'merchandis'],
    skills: ['Prospecting and lead research', 'Customer conversations', 'Negotiation', 'CRM and spreadsheets'], target: [65, 70, 65, 60],
    project: 'Help a local business find and approach twenty new customers, and record what worked', internship: 'a sales or business development internship' },
  { k: 'content', name: 'Content and Communications Associate', kw: ['content', 'writer', 'editor', 'journalist', 'journalism', 'reporter', 'copywriter', 'communications', 'anchor', 'author', 'blogger', 'correspondent', 'sub-editor', '~media'],
    skills: ['Writing and editing', 'Fact-checking', 'Social media', 'SEO basics'], target: [75, 70, 65, 55],
    project: 'Write and publish a six-part explainer series for a local organisation', internship: 'a content or communications internship' },
  { k: 'hr', name: 'HR / People Analytics Associate', kw: ['hr', 'human resource', 'human resources', 'recruiter', 'recruitment', 'talent', 'people analytics', 'people operations', 'learning and development', 'organisational development', 'organizational development', 'industrial psychologist', 'payroll'],
    skills: ['Excel and data analysis', 'Research methods', 'Psychometric testing basics', 'Labour law basics'], target: [70, 70, 65, 60],
    project: 'Run a short employee-wellbeing survey for a local NGO or startup and present what you find', internship: 'an HR or people-analytics internship' },
  { k: 'wellbeing', name: 'Mental Health and Wellbeing Associate', kw: ['counsellor', 'counselor', 'counselling', 'counseling', 'therapist', 'psychologist', 'mental health', 'wellbeing', 'clinical psycholog', 'psychotherap', 'rehabilitation'],
    skills: ['Active listening', 'Case documentation', 'Psychological first aid', 'Ethics and confidentiality'], target: [75, 65, 70, 75],
    project: 'Co-run a peer-support or awareness programme with your college counselling centre', internship: 'a supervised placement with a hospital, NGO or counselling centre' },
  { k: 'social', name: 'Development Sector Associate', kw: ['social work', 'social worker', 'ngo', 'development sector', '~community', 'nonprofit', 'non-profit', 'csr', 'programme officer', 'program officer', 'field coordinator', 'fundraising'],
    skills: ['Community engagement', 'Programme planning and monitoring', 'Report and proposal writing', 'Field data collection'], target: [70, 65, 70, 65],
    project: 'Work with a local NGO on one field survey and write the short report they need', internship: 'a field placement with an NGO or CSR team' },
  { k: 'finance', name: 'Financial Analyst', kw: ['finance', 'financial', 'accountant', 'accounting', 'accounts', 'audit', 'auditor', 'chartered accountant', 'tax', 'taxation', 'investment', 'equity', 'treasury', 'bookkeep', 'cfa', 'actuar', 'cost accountant'],
    skills: ['Accounting fundamentals', 'Excel and financial modelling', 'Taxation and GST basics', 'Financial statement analysis'], target: [70, 70, 60, 65],
    project: 'Analyse three years of annual reports from one listed company and write a two-page view on its health', internship: 'an accounts, audit or finance internship' },
  { k: 'banking', name: 'Banking Associate', kw: ['bank', 'banking', 'banker', 'insurance', 'loan officer', 'credit analyst', 'probationary officer', 'nbfc', 'wealth', 'underwrit'],
    skills: ['Banking and financial products', 'Quantitative aptitude', 'Customer handling', 'Regulation and compliance basics'], target: [65, 70, 70, 60],
    project: 'Compare the savings and loan products of three banks for a first-time earner and present the best fit', internship: 'an internship at a bank branch, NBFC or insurer' },
  { k: 'consulting', name: 'Business Analyst', kw: ['consultant', 'consulting', 'business analyst', 'strategy', 'management trainee', '~analyst', 'associate consultant'],
    skills: ['Structured problem solving', 'Excel and data analysis', 'Presentation and slide writing', 'Business fundamentals'], target: [70, 70, 70, 65],
    project: 'Take one real problem a local business has, size it with data, and present three options', internship: 'an analyst internship with a consulting or strategy team' },
  { k: 'operations', name: 'Operations Associate', kw: ['operations', 'supply chain', 'logistics', 'procurement', 'purchase', 'warehouse', 'inventory', 'production planning', 'quality assurance', 'administrator', 'office manager', 'facility'],
    skills: ['Process mapping', 'Excel and reporting', 'Vendor and inventory basics', 'Coordination and follow-up'], target: [65, 70, 60, 70],
    project: 'Map one process at a local business or your college office and show where time is lost', internship: 'an operations or supply-chain internship' },
  { k: 'founder', name: 'Founder / Entrepreneurship', kw: ['founder', 'co-founder', 'entrepreneur', 'startup', 'start-up', 'own business', 'self-employed', 'family business'],
    skills: ['Customer discovery', 'Business model design', 'Basic finance', 'Pitching'], target: [70, 65, 60, 70],
    project: 'Interview 20 potential users and turn what you learn into a one-page business model', internship: 'an internship at an early-stage startup or your college incubator' },
  { k: 'teaching', name: 'Teacher', kw: ['teacher', 'teaching', 'professor', 'lecturer', 'tutor', 'educator', 'faculty', 'trainer', 'instructional', 'school', 'curriculum'],
    skills: ['Subject knowledge', 'Lesson planning', 'Classroom communication', 'Assessment and feedback'], target: [75, 65, 75, 65],
    project: 'Teach a four-session bridge course for juniors or a local school and collect feedback', internship: 'a teaching assistantship or school internship' },
  { k: 'research', name: 'Research Associate', kw: ['~research', '~researcher', '~scientist', 'phd', '~academic', 'research assistant', 'research associate', 'research fellow', 'policy researcher'],
    skills: ['Research design', 'Statistics and data analysis', 'Academic writing', 'Literature review'], target: [70, 70, 70, 70],
    project: 'Carry one small study from question to written paper and present it at a student conference', internship: 'a research assistantship with a faculty member or institute' },
  { k: 'law', name: 'Legal Associate', kw: ['law', 'lawyer', 'advocate', 'legal', 'paralegal', 'judiciary', 'judge', 'litigation', 'company secretary', 'compliance officer', 'solicitor'],
    skills: ['Legal research', 'Drafting', 'Knowledge of core laws', 'Argument and advocacy'], target: [70, 70, 70, 65],
    project: 'Research one live legal question and write a case note a practising lawyer would accept', internship: 'an internship with an advocate, law firm or legal aid clinic' },
  { k: 'civil', name: 'Civil Services', kw: ['ias', 'ips', 'ifs', 'upsc', 'civil service', 'civil services', 'government job', 'government officer', 'public policy', 'policy analyst', 'kas', 'kpsc', 'ssc', 'public administration', 'state service'],
    skills: ['General studies and current affairs', 'Answer and essay writing', 'Quantitative and logical reasoning', 'Governance and policy knowledge'], target: [70, 70, 65, 65],
    project: 'Study one government scheme in your district and write a short note on how it works on the ground', internship: 'an internship with a government office, MP or MLA office, or policy organisation' },
  { k: 'health', name: 'Healthcare Associate', kw: ['nurse', 'nursing', 'doctor', 'physician', 'medical', 'physiotherap', 'pharmacist', 'pharmacy', 'dentist', 'hospital', 'clinical research', 'lab technician', 'public health', 'healthcare', 'paramedic', 'nutritionist', 'dietitian', 'dietician', 'optometr'],
    skills: ['Clinical or subject knowledge', 'Patient communication', 'Documentation and records', 'Safety and ethics protocols'], target: [75, 70, 65, 75],
    project: 'Run one health-awareness or screening activity with a supervisor and record what you learned', internship: 'a supervised hospital, clinic or public-health posting' },
  { k: 'engineering', name: 'Core Engineer', kw: ['mechanical', 'civil engineer', 'electrical', 'electronics', 'embedded', 'vlsi', 'automobile', 'automotive', 'manufacturing', 'site engineer', 'structural', 'design engineer', 'cad', 'chemical engineer', 'aerospace', '~engineer', 'robotics', 'instrumentation'],
    skills: ['Core engineering fundamentals', 'CAD or simulation tools', 'Standards and safety practice', 'Technical reporting'], target: [70, 65, 65, 65],
    project: 'Design, build and test one working prototype and write the technical report', internship: 'a plant, site or design-office internship' },
  { k: 'science', name: 'Laboratory Scientist', kw: ['biotech', 'microbiolog', 'chemist', 'laboratory', 'quality control', 'food technolog', 'environmental', 'geolog', 'agricultur', 'agronom', 'biologist', 'physicist', 'zoolog', 'botan'],
    skills: ['Laboratory techniques', 'Data recording and analysis', 'Safety and quality standards', 'Scientific writing'], target: [70, 65, 70, 65],
    project: 'Complete one supervised lab or field investigation and write it up as a short paper', internship: 'a laboratory, quality-control or field internship' },
  { k: 'support', name: 'Customer Support Associate', kw: ['customer support', 'customer service', 'customer success', 'bpo', 'call centre', 'call center', 'help desk', 'helpdesk', 'technical support', 'client servicing'],
    skills: ['Spoken and written English', 'Product knowledge', 'Problem resolution', 'Ticketing and CRM tools'], target: [70, 65, 70, 60],
    project: 'Write a help guide for a product or service your college uses and test it with ten users', internship: 'a customer support or client servicing internship' },
  { k: 'hospitality', name: 'Hospitality Associate', kw: ['hotel', 'hospitality', 'chef', 'culinary', 'tourism', 'travel', 'aviation', 'cabin crew', 'event manager', 'event management', 'front office'],
    skills: ['Guest service', 'Operations basics', 'Spoken English and a second language', 'Grooming and workplace etiquette'], target: [75, 65, 70, 70],
    project: 'Plan and run one college or community event end to end and collect guest feedback', internship: 'an internship with a hotel, airline, travel firm or events team' },
  { k: 'creative', name: 'Creative Professional', kw: ['musician', 'actor', 'artist', 'film', 'photographer', 'video editor', 'videographer', 'fashion', 'architect', 'interior', 'dancer', 'singer', 'theatre'],
    skills: ['Craft and technique', 'Portfolio of work', 'Working to a client brief', 'Tools of the trade'], target: [75, 70, 65, 65],
    project: 'Complete one commissioned piece for a real client and add it to your portfolio', internship: 'an apprenticeship or studio internship' },
];
// When nothing matches: workable generic skills, flagged so an admin can set the right ones.
const GENERAL = { k: 'general', name: 'Graduate role', kw: [],
  skills: ['Knowledge of the field', 'Problem solving', 'Digital tools (documents, spreadsheets, email)', 'Workplace communication'], target: [65, 65, 65, 70],
  project: 'Do one piece of real work for an organisation in this field and get it reviewed by someone who does the job', internship: 'an internship or shadowing placement in this field' };

// Which families a discipline leads to directly, and which it is a reasonable base for.
const DISCIPLINES = [
  { k: 'psychology', name: 'psychology', kw: ['psycholog'], direct: ['hr', 'wellbeing', 'ux', 'research'], related: ['social', 'teaching', 'marketing', 'content', 'civil', 'product'] },
  { k: 'cs', name: 'computing', kw: ['computer', 'information technology', 'bca', 'mca', 'software', 'data science', 'artificial intelligence', 'information science', 'cyber'], direct: ['software', 'data', 'ai', 'cyber'], related: ['product', 'ux', 'consulting', 'research', 'support', 'founder', 'engineering'] },
  { k: 'commerce', name: 'commerce', kw: ['bcom', 'mcom', 'commerce', 'accounting', 'accountancy'], direct: ['finance', 'banking', 'marketing', 'sales', 'operations'], related: ['consulting', 'founder', 'data', 'hr', 'civil', 'law'] },
  { k: 'management', name: 'management', kw: ['bba', 'mba', 'bbm', 'bms', 'pgdm', 'management', 'business administration'], direct: ['marketing', 'sales', 'operations', 'consulting', 'hr', 'founder', 'product'], related: ['finance', 'banking', 'data', 'support', 'hospitality'] },
  { k: 'economics', name: 'economics', kw: ['economics', 'econometrics'], direct: ['data', 'finance', 'consulting', 'research', 'civil'], related: ['banking', 'marketing', 'product', 'ai', 'founder'] },
  { k: 'media', name: 'journalism and media', kw: ['journalism', 'mass communication', 'mass comm', 'media studies', 'communication studies', 'film studies'], direct: ['content', 'marketing', 'creative'], related: ['ux', 'social', 'civil', 'sales', 'design'] },
  { k: 'law', name: 'law', kw: ['llb', 'llm', 'law', 'legal studies', 'ba llb', 'bba llb', 'bcom llb'], direct: ['law', 'civil'], related: ['hr', 'consulting', 'research', 'content', 'banking'] },
  { k: 'health', name: 'health sciences', kw: ['mbbs', 'nursing', 'pharm', 'physiotherap', 'bds', 'dental', 'medical', 'public health', 'nutrition', 'optometr', 'ayurved', 'bams', 'bhms', 'allied health'], direct: ['health', 'science'], related: ['research', 'wellbeing', 'social', 'teaching'] },
  { k: 'education', name: 'education', kw: ['bed', 'med', 'education', 'deled'], direct: ['teaching'], related: ['research', 'social', 'content', 'hr', 'wellbeing'] },
  { k: 'socialwork', name: 'social work', kw: ['social work', 'msw', 'bsw', 'development studies', 'rural development'], direct: ['social', 'wellbeing'], related: ['hr', 'research', 'civil', 'teaching'] },
  { k: 'design', name: 'design', kw: ['design', 'fine arts', 'architecture', 'barch', 'animation', 'fashion', 'visual arts', 'bdes', 'bfa'], direct: ['design', 'creative', 'ux'], related: ['product', 'marketing', 'content'] },
  { k: 'hospitality', name: 'hospitality', kw: ['hotel management', 'hospitality', 'tourism', 'aviation', 'culinary', 'bhm'], direct: ['hospitality'], related: ['sales', 'support', 'operations', 'marketing'] },
  { k: 'engineering', name: 'engineering', kw: ['btech', 'be', 'mtech', 'engineering', 'mechanical', 'civil', 'electrical', 'electronics', 'chemical', 'aerospace'], direct: ['engineering'], related: ['software', 'data', 'operations', 'product', 'consulting', 'ai', 'research', 'civil'] },
  { k: 'science', name: 'science', kw: ['bsc', 'msc', 'physics', 'chemistry', 'mathematics', 'maths', 'statistics', 'biology', 'biotech', 'microbiolog', 'zoology', 'botany', 'biochem', 'agricultur', 'environmental', 'geology', 'food'], direct: ['science', 'research', 'teaching'], related: ['data', 'ai', 'health', 'civil', 'engineering'] },
  { k: 'humanities', name: 'arts and humanities', kw: ['ba', 'ma', 'english', 'history', 'sociology', 'political science', 'philosophy', 'literature', 'languages', 'humanities', 'liberal arts', 'geography', 'public administration', 'anthropolog', 'kannada', 'hindi'], direct: ['content', 'teaching', 'civil', 'research'], related: ['social', 'hr', 'marketing', 'law', 'ux', 'support'] },
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+.&/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const flat = (s) => norm(s).replace(/\./g, '').replace(/\s+/g, ' ').trim(); // "B.A." and "BA" match the same keyword
// Tidy what someone typed: one line, sensible length and characters. Returns null when it is not usable.
function clean(text, max = 60) {
  const t = String(text || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  // Needs at least one letter (Latin or an Indian script) and must not be a link or an email address.
  return t.length >= 2 && /[a-zA-Z\u0900-\u0DFF]/.test(t) && !/https?:|www\.|@/i.test(t) ? t : null;
}
const slug = (prefix, text) => prefix + norm(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
// Whole-word keyword match; the longest keywords found decide.
function best(list, text) {
  const t = ' ' + flat(text) + ' ';
  let top = null, topScore = 0;
  for (const item of list) {
    let score = 0;
    for (const kw of item.kw) {
      // A keyword starting with ~ is a generic word (analyst, engineer, research): it only decides when nothing specific matches.
      const weak = kw[0] === '~', k = flat(weak ? kw.slice(1) : kw), at = t.indexOf(' ' + k);
      if (at < 0) continue;
      const end = t[at + 1 + k.length];
      // Short keywords must be whole words; longer stems (e.g. "psycholog") may continue.
      if (k.length <= 4 && end !== ' ') continue;
      score = Math.max(score, weak ? 1 : k.length + (end === ' ' ? 0.5 : 0));
    }
    if (score > topScore) { top = item; topScore = score; }
  }
  return top;
}
const familyOf = (text) => best(FAMILIES, text) || GENERAL;
const disciplineOf = (text) => best(DISCIPLINES, text);
const family = (k) => FAMILIES.find((f) => f.k === k) || GENERAL;

// How long the degree usually runs, from its name.
function yearsOf(text) {
  const t = ' ' + flat(text) + ' ';
  if (/ (mbbs|barch|ba llb|bba llb|bcom llb|integrated|pharm ?d) /.test(t)) return 5;
  if (/ (btech|be|bpharm|bds|bdes|bhm|bsc nursing|bpt|bams|bhms|bvsc) /.test(t)) return 4;
  if (/ (ma|msc|mcom|mba|mca|mtech|msw|med|llm|pgdm|pg diploma|bed|masters?|postgraduate) /.test(t)) return 2;
  return 3;
}

// A role record built from typed text.
function makeRole(text) {
  const label = clean(text); if (!label) return null;
  const f = familyOf(label);
  return { key: slug('r-', label), label, family: f.k, skills: f.skills.slice(), target: f.target.slice(), project: f.project, internship: f.internship, needsReview: f.k === 'general' };
}
function makeProgramme(text) {
  const label = clean(text, 80); if (!label) return null;
  const d = disciplineOf(label);
  return { id: slug('p-', label), label, years: yearsOf(label), discipline: d ? d.k : 'general' };
}

// direct: the programme leads to this kind of role. related: a reasonable base. switch: a change of direction.
function fit(discipline, fam) {
  const d = DISCIPLINES.find((x) => x.k === discipline);
  if (!d || fam === 'general') return 'open';
  if (fam === 'founder') return 'related';
  return d.direct.includes(fam) ? 'direct' : d.related.includes(fam) ? 'related' : 'switch';
}
const FIT_LABEL = { direct: 'Direct path', related: 'Related path', switch: 'Career switch', open: 'Your own path' };
// Role families a programme commonly leads to, for suggestions.
function suggestFor(discipline) {
  const d = DISCIPLINES.find((x) => x.k === discipline);
  return d ? d.direct.concat(d.related.slice(0, 2)) : [];
}

module.exports = { FAMILIES, GENERAL, DISCIPLINES, FIT_LABEL, norm, clean, slug, familyOf, disciplineOf, family, yearsOf, makeRole, makeProgramme, fit, suggestFor };
