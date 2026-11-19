// Optional AI wording for recommendation reasons. Gemini only rewrites text; it never sees a name,
// email or raw questionnaire answers, and anything it returns is checked before use.
const crypto = require('node:crypto');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/** Reject rewrites that add numbers, change length wildly, or look like more than a reason. */
function isSafeRewrite(source, candidate) {
  if (typeof candidate !== 'string') return false;
  const text = candidate.trim();
  if (text.length < 20 || text.length > Math.max(400, source.length * 2)) return false;
  const nums = (s) => (s.match(/\d+(\.\d+)?/g) || []);
  const allowed = new Set(nums(source));
  if (nums(text).some((n) => !allowed.has(n))) return false; // no new numbers
  if (/https?:\/\//i.test(text)) return false;
  return true;
}

const sourceHash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

async function rewrite(reason, targetRoleLabel) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const prompt = `Rewrite this explanation for a university student in India so it is warm, plain and short (one or two sentences). ` +
    `Keep every number exactly as written. Do not add any new numbers, facts, steps, names or links. The student's target role is ${targetRoleLabel}.\n\nExplanation: ${reason}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 200 } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    return isSafeRewrite(reason, text) ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A first look at an uploaded proof file, only for students who agreed to it. The answer is a hint for the mentor:
// it never verifies anything by itself. Returns null when no key is set, the call fails or the answer is unusable.
const ANSWERS = ['yes', 'no', 'unclear'];
function cleanCheck(x) {
  if (!x || typeof x !== 'object') return null;
  const word = (v) => (ANSWERS.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'unclear');
  const text = (v, n) => String(v ?? '').replace(/https?:\/\/\S+/gi, '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) || null;
  const out = { nameMatches: word(x.name_matches), titleMatches: word(x.title_matches), issuer: text(x.issuer, 80), date: text(x.date_on_document, 30), summary: text(x.summary, 200) };
  return out.summary || out.issuer || out.nameMatches !== 'unclear' || out.titleMatches !== 'unclear' ? out : null;
}
async function checkProof({ buffer, mime, studentName, title, typeLabel }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !buffer || !buffer.length) return null;
  const prompt = 'You help a college mentor in India check a proof document a student uploaded. Answer only from what the document shows. ' +
    `The student says it is: ${typeLabel}, "${title}". The student's name on GRM is "${studentName}". ` +
    'Reply as JSON with: name_matches ("yes", "no" or "unclear": does the name on the document match the student\'s name), title_matches ("yes", "no" or "unclear": does the document match what the student says it is), ' +
    'issuer (who issued it, or empty), date_on_document (as written, or empty), summary (one plain sentence on what the document is; no advice, no links).';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: buffer.toString('base64') } }, { text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 400, responseMimeType: 'application/json' } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    try { return cleanCheck(JSON.parse(raw)); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { rewrite, isSafeRewrite, sourceHash, checkProof, cleanCheck };
