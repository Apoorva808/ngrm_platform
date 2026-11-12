// Sign-in with a one-time code sent to the user's email, and cookie sessions.
// Codes and session tokens are stored only as salted hashes.
const crypto = require('node:crypto');

const SECRET = () => process.env.SESSION_SECRET || 'dev-only-secret-change-me';
const hash = (v) => crypto.createHmac('sha256', SECRET()).update(String(v)).digest('hex');
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_GAP_MS = 30 * 1000;        // at most one code every 30 seconds per email
const HOURLY_LIMIT = 5;
const PW_WINDOW_MS = 15 * 60 * 1000; // five wrong passwords in 15 minutes locks password sign-in for that email
const PW_MIN = 10;
const COMMON = ['password', 'passw0rd', 'qwerty', 'letmein', 'welcome', 'iloveyou', 'admin', 'login', 'student', 'ngrm', 'changeme', 'abc123', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'cricket', 'india123', 'bangalore', 'bengaluru'];

// Passwords are stored only as salted scrypt hashes.
const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) => 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
function passwordMatches(stored, pw) {
  const [, salt, want] = String(stored || '').split('$');
  if (!salt || !want) return false;
  const a = Buffer.from(hashPassword(pw, salt).split('$')[2], 'hex'), b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const DUMMY = hashPassword('not-a-real-password', '00');              // and five per hour, so codes cannot be guessed by asking again and again

function makeAuth(h, { audit, sendCode }) {
  // Limits apply to every email, known or not, so the limit itself reveals nothing.
  function throttle(email) {
    const now = Date.now();
    h.run('DELETE FROM otp_requests WHERE at < ?', now - 60 * 60 * 1000);
    const recent = h.all('SELECT at FROM otp_requests WHERE email = ? ORDER BY at DESC', email);
    if (recent.length && now - recent[0].at < MIN_GAP_MS) return { error: 'A code was sent a moment ago. Wait 30 seconds before asking for another.', status: 429 };
    if (recent.length >= HOURLY_LIMIT) return { error: 'Too many codes asked for this email. Try again in an hour.', status: 429 };
    h.run('INSERT INTO otp_requests (email, at) VALUES (?, ?)', email, now);
    return null;
  }
  function requestCode(email) {
    email = String(email || '').trim().toLowerCase();
    const limited = throttle(email); if (limited) return limited;
    const user = h.get('SELECT id FROM users WHERE email = ?', email);
    // Same response whether or not the account exists, so emails can't be probed.
    if (!user) return { sent: true, devNote: process.env.DEV_SHOW_OTP === 'true' ? 'No account uses this email. Create one from the sign-up page.' : undefined };
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

  // ---------- Sign-up ----------
  // Step 1: keep the details (password as a hash only) and email a code. The answer is the same whether or not the email
  // already has an account; an existing account simply gets an ordinary sign-in code.
  function signUpStart({ name, email, role, institutionId, orgName, password }) {
    const problem = passwordProblem(password, email); if (problem) return { error: problem, status: 400 };
    const limited = throttle(email); if (limited) return limited;
    const code = String(crypto.randomInt(100000, 1000000));
    const dev = process.env.DEV_SHOW_OTP === 'true' ? code : undefined;
    h.run("DELETE FROM signups WHERE status = 'unverified' AND expires_at < ?", Date.now() - 24 * 60 * 60 * 1000);
    if (h.get('SELECT id FROM users WHERE email = ?', email)) {
      h.run('INSERT INTO otp_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0', email, hash(email + ':' + code), Date.now() + OTP_TTL_MS);
      sendCode(email, code);
      return { sent: true, devCode: dev };
    }
    // A request already waiting for approval is left untouched, so nobody else can overwrite it.
    if (h.get("SELECT 1 FROM signups WHERE email = ? AND status = 'waiting'", email)) return { sent: true, devNote: process.env.DEV_SHOW_OTP === 'true' ? 'This email already has a request waiting for approval.' : undefined };
    h.run(`INSERT INTO signups (email, name, role, institution_id, org_name, pw_hash, code_hash, expires_at, attempts, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unverified')
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, institution_id = excluded.institution_id, org_name = excluded.org_name, pw_hash = excluded.pw_hash,
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, status = 'unverified', created_at = datetime('now')`,
      email, name, role, institutionId ?? null, orgName || null, hashPassword(password), hash('signup:' + email + ':' + code), Date.now() + OTP_TTL_MS);
    sendCode(email, code);
    audit(null, 'auth.sign_up_started', role);
    return { sent: true, devCode: dev };
  }
  // Step 2: the code proves the email. Students get their account now; other roles wait for an admin.
  function signUpVerify(email, code) {
    email = String(email || '').trim().toLowerCase();
    if (h.get('SELECT id FROM users WHERE email = ?', email)) return verifyCode(email, code);
    const row = h.get("SELECT * FROM signups WHERE email = ? AND status = 'unverified'", email);
    if (!row || row.expires_at < Date.now()) return { error: 'That code has expired. Start again to get a new one.' };
    if (row.attempts >= MAX_ATTEMPTS) return { error: 'Too many wrong attempts. Start again to get a new code.' };
    const given = Buffer.from(hash('signup:' + email + ':' + String(code || '').trim()), 'hex'), stored = Buffer.from(row.code_hash, 'hex');
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
      h.run('UPDATE signups SET attempts = attempts + 1 WHERE email = ?', email);
      return { error: 'That code is not right. Check the email and try again.' };
    }
    if (row.role !== 'student') { h.run("UPDATE signups SET status = 'waiting', expires_at = 0 WHERE email = ?", email); audit(null, 'auth.sign_up_waiting', row.role); return { pending: true }; }
    const user = createFromSignup(row, row.institution_id, null);
    return { token: startSession(user.id, 'password'), user };
  }
  function createFromSignup(row, institutionId, employerId) {
    return h.tx(() => {
      const id = Number(h.run('INSERT INTO users (email, name, role, institution_id, employer_id, is_sample) VALUES (?, ?, ?, ?, ?, 0)', row.email, row.name, row.role, institutionId ?? null, employerId ?? null).lastInsertRowid);
      h.run('INSERT INTO passwords (user_id, hash) VALUES (?, ?)', id, row.pw_hash);
      h.run('DELETE FROM signups WHERE email = ?', row.email);
      audit(id, 'auth.signed_up', row.role);
      return h.get('SELECT * FROM users WHERE id = ?', id);
    });
  }
  // True when this email has a verified sign-up waiting for approval and the password given is the one chosen.
  const waitingWith = (email, pw) => { const r = h.get("SELECT pw_hash FROM signups WHERE email = ? AND status = 'waiting'", String(email || '').trim().toLowerCase()); return !!r && passwordMatches(r.pw_hash, pw); };

  const hasPassword = (userId) => !!h.get('SELECT 1 FROM passwords WHERE user_id = ?', userId);
  function passwordProblem(pw, email) {
    pw = String(pw ?? '');
    if (pw.length < PW_MIN) return `Use at least ${PW_MIN} characters. A short sentence works well.`;
    if (pw.length > 200) return 'That password is too long.';
    if (new Set(pw).size < 5) return 'Use more varied characters.';
    // Refuse the passwords attackers try first: common words with digits tacked on, keyboard runs, and the site's own name.
    const low = pw.toLowerCase(), core = low.replace(/[^a-z]/g, '');
    if (COMMON.some((w) => core === w || low.includes(w)) || /^\d+$/.test(pw) || /(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|zxcv)/.test(low) && core.length < 8)
      return 'That password is too easy to guess. Try three or four unrelated words.';
    const local = String(email || '').split('@')[0].toLowerCase();
    if (local.length >= 4 && low.includes(local)) return 'Do not use your email name in the password.';
    return null;
  }
  // Sets or changes a password and signs the person out everywhere else.
  function setPassword(user, pw, keepToken) {
    const problem = passwordProblem(pw, user.email); if (problem) return { error: problem };
    if (checkPassword(user.id, pw)) return { error: 'Choose a password different from your current one.' };
    h.run("INSERT INTO passwords (user_id, hash, must_change) VALUES (?, ?, 0) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, must_change = 0, updated_at = datetime('now')", user.id, hashPassword(pw));
    h.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', user.id, keepToken ? hash(keepToken) : '');
    audit(user.id, 'auth.password_set');
    return { ok: true };
  }
  // A temporary password an admin hands to someone. It is shown once, stored only as a hash, and must be changed at first sign-in.
  function setTempPassword(userId) {
    const A = 'abcdefghjkmnpqrstuvwxyz23456789', pick = () => Array.from({ length: 4 }, () => A[crypto.randomInt(0, A.length)]).join('');
    const pw = [pick(), pick(), pick()].join('-');
    h.run("INSERT INTO passwords (user_id, hash, must_change) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET hash = excluded.hash, must_change = 1, updated_at = datetime('now')", userId, hashPassword(pw));
    h.run('DELETE FROM sessions WHERE user_id = ?', userId);
    return pw;
  }
  const mustChange = (userId) => !!(h.get('SELECT must_change FROM passwords WHERE user_id = ?', userId) || {}).must_change;
  // Sign-up without emailed codes: the account (or, for staff roles, the request) is made at once.
  function signUpDirect({ name, email, role, institutionId, orgName, password }) {
    const problem = passwordProblem(password, email); if (problem) return { error: problem, status: 400 };
    if (h.get('SELECT id FROM users WHERE email = ?', email)) return { error: 'This email already has an account. Sign in instead.', status: 409 };
    if (h.get("SELECT 1 FROM signups WHERE email = ? AND status = 'waiting'", email)) return { error: 'This email already has a request waiting for approval.', status: 409 };
    h.run('DELETE FROM signups WHERE email = ?', email);
    h.run("INSERT INTO signups (email, name, role, institution_id, org_name, pw_hash, code_hash, expires_at, attempts, status) VALUES (?, ?, ?, ?, ?, ?, '', 0, 0, ?)",
      email, name, role, institutionId ?? null, orgName || null, hashPassword(password), role === 'student' ? 'unverified' : 'waiting');
    if (role !== 'student') { audit(null, 'auth.sign_up_waiting', role); return { pending: true }; }
    const user = createFromSignup(h.get('SELECT * FROM signups WHERE email = ?', email), institutionId, null);
    return { token: startSession(user.id, 'password'), user };
  }
  const checkPassword = (userId, pw) => passwordMatches((h.get('SELECT hash FROM passwords WHERE user_id = ?', userId) || {}).hash, pw);
  function signInWithPassword(email, pw) {
    email = String(email || '').trim().toLowerCase();
    const now = Date.now();
    h.run('DELETE FROM login_failures WHERE at < ?', now - PW_WINDOW_MS);
    if (h.get('SELECT COUNT(*) AS n FROM login_failures WHERE email = ?', email).n >= MAX_ATTEMPTS) return { error: 'Too many wrong tries. Wait 15 minutes, or sign in with an emailed code.', status: 429 };
    const user = h.get('SELECT * FROM users WHERE email = ?', email);
    const row = user && h.get('SELECT hash FROM passwords WHERE user_id = ?', user.id);
    // The same work and the same answer whether the email exists, has a password, or the password is wrong.
    const ok = passwordMatches(row ? row.hash : DUMMY, pw) && !!row;
    if (!ok) { h.run('INSERT INTO login_failures (email, at) VALUES (?, ?)', email, now); return { error: 'That email and password do not match. You can also sign in with an emailed code.', status: 400 }; }
    h.run('DELETE FROM login_failures WHERE email = ?', email);
    return { token: startSession(user.id, 'password'), user };
  }

  function startSession(userId, via = 'code') {
    h.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    h.run('INSERT INTO sessions (token_hash, user_id, expires_at, via) VALUES (?, ?, ?, ?)', hash(token), userId, Date.now() + SESSION_TTL_MS, via);
    audit(userId, 'auth.signed_in');
    return token;
  }

  function endSession(token) { if (token) h.run('DELETE FROM sessions WHERE token_hash = ?', hash(token)); }

  function userFromToken(token) {
    if (!token) return null;
    const s = h.get('SELECT user_id, expires_at, via FROM sessions WHERE token_hash = ?', hash(token));
    if (!s || s.expires_at < Date.now()) return null;
    const u = h.get('SELECT id, email, name, role, institution_id, employer_id FROM users WHERE id = ?', s.user_id);
    return u ? { ...u, via: s.via, mustChange: mustChange(u.id) } : null;
  }

  return { requestCode, verifyCode, startSession, endSession, userFromToken, signInWithPassword, setPassword, checkPassword, hasPassword, signUpStart, signUpVerify, signUpDirect, setTempPassword, mustChange, createFromSignup, waitingWith, SESSION_TTL_MS };
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

module.exports = { makeAuth, readCookie, hashPassword };
