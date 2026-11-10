// Sign-in with a one-time code sent to the user's email, and cookie sessions.
// Codes and session tokens are stored only as salted hashes.
const crypto = require('node:crypto');

const SECRET = () => process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const hash = (v) => crypto.createHmac('sha256', SECRET()).update(String(v)).digest('hex');
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_GAP_MS = 30 * 1000;        // at most one code every 30 seconds per email
const HOURLY_LIMIT = 5;              // and five per hour, so codes cannot be guessed by asking again and again

function makeAuth(h, { audit, sendCode }) {
  function requestCode(email) {
    email = String(email || '').trim().toLowerCase();
    // Limits apply to every email, known or not, so the limit itself reveals nothing.
    const now = Date.now();
    h.run('DELETE FROM otp_requests WHERE at < ?', now - 60 * 60 * 1000);
    const recent = h.all('SELECT at FROM otp_requests WHERE email = ? ORDER BY at DESC', email);
    if (recent.length && now - recent[0].at < MIN_GAP_MS) return { error: 'A code was sent a moment ago. Wait 30 seconds before asking for another.', status: 429 };
    if (recent.length >= HOURLY_LIMIT) return { error: 'Too many codes asked for this email. Try again in an hour.', status: 429 };
    h.run('INSERT INTO otp_requests (email, at) VALUES (?, ?)', email, now);
    const user = h.get('SELECT id FROM users WHERE email = ?', email);
    // Same response whether or not the account exists, so emails can't be probed.
    if (!user) return { sent: true, devNote: process.env.DEV_SHOW_OTP === 'true' ? 'No account uses this email. In the pilot, accounts are added by an admin.' : undefined };
    const code = String(crypto.randomInt(100000, 1000000));
    h.run('INSERT INTO otp_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0',
      email, hash(email + ':' + code), Date.now() + OTP_TTL_MS);
    sendCode(email, code);
    audit(user.id, 'auth.code_requested');
    return { sent: true, devCode: process.env.DEV_SHOW_OTP === 'true' ? code : undefined };
  }

  function verifyCode(email, code) {
    email = String(email || '').trim().toLowerCase();
    const row = h.get('SELECT * FROM otp_codes WHERE email = ?', email);
    if (!row || row.expires_at < Date.now()) return { error: 'That code has expired. Ask for a new one.' };
    if (row.attempts >= MAX_ATTEMPTS) return { error: 'Too many wrong attempts. Ask for a new code.' };
    const given = Buffer.from(hash(email + ':' + String(code || '').trim()), 'hex'), stored = Buffer.from(row.code_hash, 'hex');
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
      h.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?', email);
      return { error: 'That code is not right. Check the email and try again.' };
    }
    h.run('DELETE FROM otp_codes WHERE email = ?', email);
    const user = h.get('SELECT * FROM users WHERE email = ?', email);
    if (!user) return { error: 'That code has expired. Ask for a new one.' };
    return { token: startSession(user.id), user };
  }

  function startSession(userId) {
    h.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    h.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', hash(token), userId, Date.now() + SESSION_TTL_MS);
    audit(userId, 'auth.signed_in');
    return token;
  }

  function endSession(token) { if (token) h.run('DELETE FROM sessions WHERE token_hash = ?', hash(token)); }

  function userFromToken(token) {
    if (!token) return null;
    const s = h.get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', hash(token));
    if (!s || s.expires_at < Date.now()) return null;
    return h.get('SELECT id, email, name, role, institution_id, employer_id FROM users WHERE id = ?', s.user_id) || null;
  }

  return { requestCode, verifyCode, startSession, endSession, userFromToken, SESSION_TTL_MS };
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

module.exports = { makeAuth, readCookie };
