// Sends sign-in codes by email. Works with Resend or Brevo (both have free tiers); set one API key and MAIL_FROM.
// No extra packages: both are plain HTTPS calls.
const subject = 'Your NGRM sign-in code';
const text = (code) => `Your NGRM sign-in code is ${code}\n\nIt works for 10 minutes. If you did not ask for it, you can ignore this email.`;

function provider(env = process.env) {
  if (!env.MAIL_FROM) return null;
  if (env.RESEND_API_KEY) return 'resend';
  if (env.BREVO_API_KEY) return 'brevo';
  return null;
}

const sendCode = (email, code, env = process.env) => sendNotice(email, subject, text(code), env);
async function sendNotice(email, subject, body, env = process.env) {
  const p = provider(env);
  if (!p) return false;
  const req = p === 'resend'
    ? ['https://api.resend.com/emails', { authorization: 'Bearer ' + env.RESEND_API_KEY }, { from: env.MAIL_FROM, to: [email], subject, text: body }]
    : ['https://api.brevo.com/v3/smtp/email', { 'api-key': env.BREVO_API_KEY }, { sender: { email: env.MAIL_FROM, name: 'NGRM' }, to: [{ email }], subject, textContent: body }];
  const r = await fetch(req[0], { method: 'POST', headers: { 'content-type': 'application/json', ...req[1] }, body: JSON.stringify(req[2]), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${p} answered ${r.status}`);
  return true;
}

module.exports = { provider, sendCode, sendNotice };
