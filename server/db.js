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
  for (const c of ['file_path', 'file_type']) if (!cols.includes(c)) db.exec(`ALTER TABLE evidence ADD COLUMN ${c} TEXT`);
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
