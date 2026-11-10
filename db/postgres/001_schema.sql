-- NGRM production schema for Supabase (Postgres 15+). Host the project in the Mumbai region (ap-south-1).
-- Mirrors server/schema.sql. Apply 001 then 002. Review with your developer before going live.

create extension if not exists pgcrypto;

create table institutions (
  id bigint generated always as identity primary key,
  name text not null,
  city text not null
);

create table employers (
  id bigint generated always as identity primary key,
  name text not null,
  city text
);

-- One row per Supabase auth user (auth.users holds email and sign-in).
create table app_users (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null check (role in ('student','mentor','college_admin','employer','researcher','admin')),
  institution_id bigint references institutions(id),
  employer_id bigint references employers(id),
  created_at timestamptz not null default now()
);

create table mentor_links (
  mentor_id uuid not null references app_users(id) on delete cascade,
  student_id uuid not null references app_users(id) on delete cascade,
  primary key (mentor_id, student_id)
);

create table consents (
  id bigint generated always as identity primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  purpose text not null check (purpose in ('profile','psychometric','ai_wording','introductions','study')),
  granted boolean not null,
  is_adult boolean,
  guardian_name text,
  created_at timestamptz not null default now()
);
create index on consents (user_id, purpose, id desc);

create table profiles (
  user_id uuid primary key references app_users(id) on delete cascade,
  programme text not null default 'ba-psy',
  year int not null default 1 check (year between 1 and 5),
  cgpa numeric(4,2) check (cgpa between 0 and 10),
  target_role text not null default 'hr',
  skills int[] not null default '{50,50,50,50}',
  ocean jsonb,
  comm numeric(5,1),
  clarity numeric(5,1),
  opt_in_intros boolean not null default false,
  updated_at timestamptz not null default now()
);

create table evidence (
  id bigint generated always as identity primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  type text not null check (type in ('course','certificate','project','internship','role','assessment')),
  title text not null check (char_length(title) <= 200),
  completed_on date,
  file_type text,
  file_path text,                      -- Supabase Storage path, private bucket
  status text not null default 'pending' check (status in ('pending','verified','needs_proof')),
  verified_by text,
  verified_at timestamptz,
  skill_index int,
  skill_role text,
  skill_value int check (skill_value between 0 and 100),   -- set by a college assessment; the student cannot change it
  created_at timestamptz not null default now()
);
create index on evidence (user_id);

create table score_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  formula_version text not null,
  inputs jsonb not null,
  factors jsonb not null,
  index_value numeric(5,1) not null,
  created_at timestamptz not null default now()
);
create index on score_runs (user_id, id desc);

create table rules (
  id text primary key,
  factor text not null,
  slot text not null,
  effort text not null,
  threshold numeric,
  active boolean not null default true
);

create table recommendation_states (
  user_id uuid not null references app_users(id) on delete cascade,
  rule_id text not null references rules(id),
  student_status text check (student_status in ('accepted','declined')),
  student_at timestamptz,
  mentor_status text check (mentor_status in ('approved','note')),
  mentor_note text,
  mentor_id uuid references app_users(id) on delete set null,
  mentor_at timestamptz,
  ai_source_hash text,
  ai_text text,
  primary key (user_id, rule_id)
);

create table baselines (
  id bigint generated always as identity primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  score_run_id bigint not null references score_runs(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table demand_posts (
  id bigint generated always as identity primary key,
  employer_id bigint not null references employers(id) on delete cascade,
  role text not null,
  skills text[] not null,
  openings int not null check (openings between 1 and 500),
  city text,
  created_at timestamptz not null default now()
);

-- Sign-in codes and their rate limits are handled by Supabase Auth in production.

create table intro_requests (
  id bigint generated always as identity primary key,
  employer_id bigint not null references employers(id) on delete cascade,
  role text not null,
  status text not null default 'sent_to_placement_cells',
  created_at timestamptz not null default now()
);

create table intro_replies (
  request_id bigint not null references intro_requests(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

create table audit_log (
  id bigint generated always as identity primary key,
  user_id uuid,
  action text not null,
  target text,
  at timestamptz not null default now()
);
