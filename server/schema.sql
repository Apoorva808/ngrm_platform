-- NGRM pilot database (SQLite for local development).
-- The production equivalent for Supabase/Postgres, with row-level security, is in db/postgres/.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS institutions (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT NOT NULL,
  is_sample   INTEGER NOT NULL DEFAULT 1,
  pending     INTEGER NOT NULL DEFAULT 0    -- 1 = typed in by someone signing up; not offered to others until an admin confirms it
);

CREATE TABLE IF NOT EXISTS employers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  city        TEXT,
  is_sample   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('student','mentor','college_admin','employer','researcher','admin')),
  institution_id  INTEGER REFERENCES institutions(id),
  employer_id     INTEGER REFERENCES employers(id),
  is_sample       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mentor_links (
  mentor_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (mentor_id, student_id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);

-- Every code request, to limit how often codes can be sent (protects against guessing).
CREATE TABLE IF NOT EXISTS otp_requests (
  email  TEXT NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS otp_requests_email ON otp_requests(email, at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  via         TEXT NOT NULL DEFAULT 'code'   -- how the person signed in: 'code' or 'password'
);

-- Optional passwords (salted scrypt hashes, never the password itself) and wrong tries, to slow guessing.
CREATE TABLE IF NOT EXISTS passwords (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash        TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,   -- 1 for a temporary password handed out by an admin
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Steps a student typed into their own plan. They are the student's own and never change the score.
CREATE TABLE IF NOT EXISTS own_steps (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  slot        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Target roles and programmes that someone typed in. A typed role takes its four skills from a role family
-- (server/library.js); an admin can correct them. listed = 1 means it is offered to everyone as a suggestion.
CREATE TABLE IF NOT EXISTS custom_roles (
  key           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  family        TEXT NOT NULL,
  skills_json   TEXT NOT NULL,
  targets_json  TEXT NOT NULL,
  project       TEXT NOT NULL,
  internship    TEXT NOT NULL,
  needs_review  INTEGER NOT NULL DEFAULT 0,
  listed        INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS custom_programmes (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  years       INTEGER NOT NULL,
  discipline  TEXT NOT NULL,
  listed      INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- People who are signing up. A row is 'unverified' until the emailed code is entered. Students then get an account at once;
-- other roles stay 'waiting' until an admin approves. The password is held only as a salted hash.
CREATE TABLE IF NOT EXISTS signups (
  email           TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('student','mentor','college_admin','employer','researcher')),
  institution_id  INTEGER REFERENCES institutions(id) ON DELETE CASCADE,
  org_name        TEXT,
  pw_hash         TEXT NOT NULL,
  code_hash       TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','waiting')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS login_failures (
  email  TEXT NOT NULL,
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures(email, at);

CREATE TABLE IF NOT EXISTS consents (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose        TEXT NOT NULL CHECK (purpose IN ('profile','psychometric','ai_wording','introductions','study')),
  granted        INTEGER NOT NULL,
  is_adult       INTEGER,
  guardian_name  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS consents_user ON consents(user_id, purpose, id);

CREATE TABLE IF NOT EXISTS profiles (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  programme      TEXT NOT NULL DEFAULT 'ba-psy',
  year           INTEGER NOT NULL DEFAULT 1,
  cgpa           REAL,
  cgpa_confirmed INTEGER NOT NULL DEFAULT 0,   -- 1 once a mentor has confirmed the CGPA against college records
  target_role    TEXT NOT NULL DEFAULT 'hr',
  skills_json    TEXT NOT NULL DEFAULT '[50,50,50,50]',
  ocean_json     TEXT,
  comm           REAL,
  clarity        REAL,
  opt_in_intros  INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evidence (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('course','certificate','project','internship','role','assessment')),
  title         TEXT NOT NULL,
  completed_on  TEXT,
  file_name     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','needs_proof')),
  verified_by   TEXT,
  verified_at   TEXT,
  skill_index   INTEGER,
  skill_role    TEXT,
  skill_value   INTEGER,
  file_path     TEXT,
  file_type     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS evidence_user ON evidence(user_id);

CREATE TABLE IF NOT EXISTS score_runs (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  formula_version  TEXT NOT NULL,
  inputs_json      TEXT NOT NULL,
  factors_json     TEXT NOT NULL,
  index_value      REAL NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS score_runs_user ON score_runs(user_id, id);

CREATE TABLE IF NOT EXISTS rules (
  id         TEXT PRIMARY KEY,
  factor     TEXT NOT NULL,
  slot       TEXT NOT NULL,
  effort     TEXT NOT NULL,
  threshold  REAL,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS recommendation_states (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id         TEXT NOT NULL REFERENCES rules(id),
  student_status  TEXT CHECK (student_status IN ('accepted','declined')),
  student_at      TEXT,
  mentor_status   TEXT CHECK (mentor_status IN ('approved','note')),
  mentor_note     TEXT,
  mentor_id       INTEGER REFERENCES users(id),
  mentor_at       TEXT,
  ai_source_hash  TEXT,
  ai_text         TEXT,
  PRIMARY KEY (user_id, rule_id)
);

CREATE TABLE IF NOT EXISTS baselines (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score_run_id  INTEGER NOT NULL REFERENCES score_runs(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS demand_posts (
  id           INTEGER PRIMARY KEY,
  employer_id  INTEGER NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  skills_json  TEXT NOT NULL,
  openings     INTEGER NOT NULL,
  city         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intro_requests (
  id           INTEGER PRIMARY KEY,
  employer_id  INTEGER NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'sent_to_placement_cells',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A student's reply to an introduction request. Only the student's own placement cell sees who replied.
CREATE TABLE IF NOT EXISTS intro_replies (
  request_id  INTEGER NOT NULL REFERENCES intro_requests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (request_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY,
  user_id  INTEGER,
  action   TEXT NOT NULL,
  target   TEXT,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Courses vetted by the team, mapped to a role skill (skill_index 0-3) or to communication (role = 'communication').
CREATE TABLE IF NOT EXISTS courses (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  url         TEXT NOT NULL,
  role        TEXT NOT NULL,
  skill_index INTEGER,
  weeks       INTEGER,
  free        INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Course sites searched live for a skill. {q} in the address is replaced by the skill name.
CREATE TABLE IF NOT EXISTS course_sources (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  url_template  TEXT NOT NULL
);

-- Live course listings fetched from a provider, kept for a day per skill.
CREATE TABLE IF NOT EXISTS live_courses (
  skill       TEXT NOT NULL,
  title       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  url         TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS live_courses_skill ON live_courses(skill);
CREATE TABLE IF NOT EXISTS feed_status (
  name        TEXT PRIMARY KEY,
  ok          INTEGER,
  message     TEXT,
  checked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at);
