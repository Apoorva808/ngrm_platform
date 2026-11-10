// Start the NGRM server: opens the database, seeds sample data on first run, serves the API and frontend.
// The built-in database (node:sqlite) works without extra flags from Node 22.13.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`NGRM needs Node.js 22.13 or newer. This computer has ${process.versions.node}. Install the current LTS from nodejs.org and try again.`);
  process.exit(1);
}
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no extra dependency).
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || /change-me/.test(process.env.SESSION_SECRET) || process.env.DEMO_MODE === 'true' || process.env.DEV_SHOW_OTP === 'true')) {
  console.error('Refusing to start in production: set SESSION_SECRET to a long random value (32+ characters, not the example), and turn off DEMO_MODE and DEV_SHOW_OTP.');
  process.exit(1);
}

const { open } = require('./db');
const { seed, bootstrap } = require('./seed');
const { createApp } = require('./app');

const db = open();
const production = process.env.NODE_ENV === 'production';
// Sample data only outside production (or when asked for explicitly with SEED_SAMPLE=true, for a demo server).
if ((!production || process.env.SEED_SAMPLE === 'true') && seed(db)) console.log('First run: loaded sample data (all people, colleges and employers are fictional).');
const admin = bootstrap(db);
if (admin) console.log(`Created the first admin account: ${admin}`);
if (production && !db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) console.warn('No admin account yet. Set ADMIN_EMAIL (and ADMIN_NAME) and restart.');
const mailer = require('./mail').provider();
console.log(mailer ? `Sign-in codes are emailed through ${mailer}.` : 'No email provider set (MAIL_FROM plus RESEND_API_KEY or BREVO_API_KEY).' + (production ? ' Nobody can sign in until one is set.' : ' Codes appear in this log.'));
const port = Number(process.env.PORT) || 3000;
const app = createApp(db);
// Behind a hosting proxy (Render, Railway, nginx), trust it so per-address limits see the real visitor address.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.listen(port, () => {
  console.log(`NGRM running at http://localhost:${port}`);
  if (process.env.DEMO_MODE === 'true') console.log('Demo mode is on: the sign-in page offers one-click sample accounts.');
});
