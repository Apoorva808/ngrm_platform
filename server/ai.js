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

module.exports = { rewrite, isSafeRewrite, sourceHash };
