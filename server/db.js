// Database access. Uses Node's built-in SQLite (Node 22.5+), so local setup needs no database server.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function open(file) {
  const dbPath = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ngrm.sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

// Bring databases created by earlier versions up to date.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(evidence)').all().map((c) => c.name);
  if (!cols.includes('skill_value')) db.exec('ALTER TABLE evidence ADD COLUMN skill_value INTEGER');
  if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'via')) db.exec("ALTER TABLE sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'code'");
  // Formula v0.2: a communication score counts only when a mentor recorded it, so self-entered ones are cleared.
  db.exec("UPDATE profiles SET comm = NULL WHERE comm IS NOT NULL AND user_id NOT IN (SELECT user_id FROM evidence WHERE type = 'assessment' AND status = 'verified' AND skill_role = 'communication')");
  if (!db.prepare('PRAGMA table_info(passwords)').all().some((c) => c.name === 'must_change')) db.exec('ALTER TABLE passwords ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');
  // Typed-in details added later: older databases get the columns here.
  const addCol = (table, col, def) => { if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  addCol('institutions', 'pending', 'INTEGER NOT NULL DEFAULT 0');
  for (const c of ['goal', 'interests', 'cities', 'own_skills_json']) addCol('profiles', c, 'TEXT');
  addCol('demand_posts', 'extra_json', 'TEXT');
  // Formula v0.3: a CGPA counts only once a mentor confirms it. Existing ones start unconfirmed.
  if (!db.prepare('PRAGMA table_info(profiles)').all().some((c) => c.name === 'cgpa_confirmed')) db.exec('ALTER TABLE profiles ADD COLUMN cgpa_confirmed INTEGER NOT NULL DEFAULT 0');
  for (const c of ['file_path', 'file_type']) if (!cols.includes(c)) db.exec(`ALTER TABLE evidence ADD COLUMN ${c} TEXT`);
  // Formula v0.4: five transversal skills the student rates, up to two more aspired roles to compare, and the
  // communication and leadership rules replaced by transversal and co-curricular ones.
  addCol('profiles', 'transversal_json', 'TEXT');
  addCol('profiles', 'other_roles_json', 'TEXT');
  // Class 12 marks stand in for the CGPA until a first-year student has one (advisers' review, November 2026).
  addCol('profiles', 'class12', 'REAL');
  addCol('profiles', 'class12_confirmed', 'INTEGER NOT NULL DEFAULT 0');
  // Advisers' review, November 2026: volunteer mentor details at sign-up, where each opening was found, and an optional AI first look at proof files.
  addCol('signups', 'extra_json', 'TEXT');
  addCol('public_openings', 'source_kind', "TEXT NOT NULL DEFAULT 'company'");
  addCol('evidence', 'ai_check_json', 'TEXT');
  // The consent list gained a purpose; SQLite cannot change a CHECK, so older databases get the table rebuilt with the same rows.
  const cons = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'consents'").get();
  if (cons && !cons.sql.includes('ai_proof_check')) {
    db.exec('BEGIN');
    try {
      db.exec("ALTER TABLE consents RENAME TO consents_old; " + cons.sql.replace(/CREATE TABLE ("?)consents\1/, 'CREATE TABLE consents').replace("'ai_wording',", "'ai_wording','ai_proof_check',") +
        "; INSERT INTO consents SELECT * FROM consents_old; DROP TABLE consents_old; CREATE INDEX IF NOT EXISTS consents_user ON consents(user_id, purpose, id);");
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  for (const id of ['communication', 'leadership']) { db.prepare('DELETE FROM recommendation_states WHERE rule_id = ?').run(id); db.prepare('DELETE FROM rules WHERE id = ?').run(id); }
}

// Small helpers so route code stays readable.
function helpers(db) {
  return {
    db,
    get: (sql, ...p) => db.prepare(sql).get(...p),
    all: (sql, ...p) => db.prepare(sql).all(...p),
    run: (sql, ...p) => db.prepare(sql).run(...p),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

module.exports = { open, helpers };
