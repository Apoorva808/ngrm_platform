-- Row-level security for NGRM on Supabase.
-- Principle: students can read their own rows; mentors read only their mentees; colleges and employers never
-- read student rows directly and get aggregates through a function that hides small groups.
-- Anything that changes a score, a locked value, a review or a verification goes through the API server
-- (service role), which enforces the rules and writes the audit log. These policies protect direct access.

alter table app_users enable row level security;
alter table mentor_links enable row level security;
alter table consents enable row level security;
alter table profiles enable row level security;
alter table evidence enable row level security;
alter table score_runs enable row level security;
alter table recommendation_states enable row level security;
alter table baselines enable row level security;
alter table demand_posts enable row level security;
alter table intro_requests enable row level security;
alter table intro_replies enable row level security;
alter table audit_log enable row level security;
alter table rules enable row level security;

-- Helper checks live in a schema that Supabase does not publish through its API, so no one can call them
-- directly to ask about another person. Policies can still use them.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create or replace function private.my_role() returns text language sql stable security definer set search_path = public as
  $$ select role from app_users where id = auth.uid() $$;
create or replace function private.my_institution() returns bigint language sql stable security definer set search_path = public as
  $$ select institution_id from app_users where id = auth.uid() $$;
create or replace function private.my_employer() returns bigint language sql stable security definer set search_path = public as
  $$ select employer_id from app_users where id = auth.uid() $$;
create or replace function private.is_my_mentee(student uuid) returns boolean language sql stable security definer set search_path = public as
  $$ select exists (select 1 from mentor_links where mentor_id = auth.uid() and student_id = student) $$;
create or replace function private.has_consent(uid uuid, p text) returns boolean language sql stable security definer set search_path = public as
  $$ select coalesce((select granted from consents where user_id = uid and purpose = p order by id desc limit 1), false) $$;
create or replace function private.institution_of(uid uuid) returns bigint language sql stable security definer set search_path = public as
  $$ select institution_id from app_users where id = uid $$;
-- Age status already on record (true if never stated), so a later consent row cannot quietly drop a guardian.
create or replace function private.is_minor(uid uuid) returns boolean language sql stable security definer set search_path = public as
  $$ select coalesce((select not is_adult from consents where user_id = uid and is_adult is not null order by id desc limit 1), false) $$;

revoke all on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

-- Accounts: your own row; mentors see their mentees' names.
create policy own_user on app_users for select using (id = auth.uid() or private.is_my_mentee(id));

-- Consent is a history: students add rows, never edit or delete them.
-- Granting anything as an under-18 needs a guardian named on the same row.
create policy consents_read on consents for select using (user_id = auth.uid());
create policy consents_add on consents for insert with check (
  user_id = auth.uid()
  and (not granted or (coalesce(is_adult, not private.is_minor(auth.uid())) or nullif(trim(guardian_name), '') is not null)));

-- Students read their own data. Profile changes go through the API, which keeps assessed scores locked,
-- stores questionnaire answers only with consent, and keeps the introductions opt-in in step with consent.
create policy own_profile on profiles for select using (user_id = auth.uid() and private.has_consent(auth.uid(), 'profile'));
create policy own_scores on score_runs for select using (user_id = auth.uid());
create policy own_recs on recommendation_states for select using (user_id = auth.uid());
create policy own_baselines on baselines for select using (user_id = auth.uid());

-- Evidence: students read their own, add new items for checking, and remove their own items except college assessments.
create policy evidence_read on evidence for select using (user_id = auth.uid());
create policy evidence_add on evidence for insert with check (
  user_id = auth.uid() and private.has_consent(auth.uid(), 'profile')
  and type <> 'assessment' and status = 'pending' and verified_by is null and verified_at is null and skill_value is null);
create policy evidence_remove on evidence for delete using (user_id = auth.uid() and type <> 'assessment');

-- Mentors: read their mentees' profile, evidence and plan, only while the student's profile consent stands.
create policy mentor_profiles on profiles for select using (private.is_my_mentee(user_id) and private.has_consent(user_id, 'profile'));
create policy mentor_evidence on evidence for select using (private.is_my_mentee(user_id) and private.has_consent(user_id, 'profile'));
create policy mentor_recs on recommendation_states for select using (private.is_my_mentee(user_id) and private.has_consent(user_id, 'profile'));
create policy mentor_links_read on mentor_links for select using (mentor_id = auth.uid() or student_id = auth.uid());

-- Employers: their own posts and requests; everyone signed in can read posts.
create policy demand_read on demand_posts for select using (auth.uid() is not null);
create policy demand_write on demand_posts for insert with check (private.my_role() = 'employer' and employer_id = private.my_employer());
create policy intros_own on intro_requests for select using (employer_id = private.my_employer());

-- Introduction replies: a student adds or withdraws their own (with consent); their own college's placement cell reads them.
create policy replies_read_own on intro_replies for select using (user_id = auth.uid());
create policy replies_add on intro_replies for insert with check (user_id = auth.uid() and private.has_consent(auth.uid(), 'introductions'));
create policy replies_remove on intro_replies for delete using (user_id = auth.uid());
create policy placement_replies on intro_replies for select using (
  private.my_role() = 'college_admin' and private.has_consent(user_id, 'introductions')
  and private.institution_of(user_id) = private.my_institution());

-- Admin only.
create policy audit_admin on audit_log for select using (private.my_role() = 'admin');
create policy rules_read on rules for select using (auth.uid() is not null);
create policy rules_admin on rules for update using (private.my_role() = 'admin');

-- Aggregates for employers: null for any count under 5, other counts rounded to the nearest 5,
-- so a total minus the visible rows cannot reveal a small group. This is the one function meant to be called.
create or replace function approx5(n bigint) returns int language sql immutable as
  $$ select case when n < 5 then null else greatest(5, (round(n / 5.0) * 5)::int) end $$;
create or replace function employer_supply(p_role text)
returns table (institution text, foundation int, intermediate int, strong int, opted_in int)
language sql stable security definer set search_path = public as $$
  with s as (
    select u.institution_id, p.skills, p.opt_in_intros and private.has_consent(u.id, 'introductions') as opted
    from app_users u join profiles p on p.user_id = u.id
    where u.role = 'student' and p.target_role = p_role and private.has_consent(u.id, 'profile')
  ), lv as (
    select institution_id, opted,
      case when (select avg(x) from unnest(skills) x) < 50 then 'f' when (select avg(x) from unnest(skills) x) < 70 then 'i' else 's' end as lvl
    from s
  ), t as (
    select i.name, count(*) filter (where lvl = 'f') f, count(*) filter (where lvl = 'i') i2, count(*) filter (where lvl = 's') st, count(*) filter (where opted) o
    from institutions i left join lv on lv.institution_id = i.id group by i.name
  )
  select name, approx5(f), approx5(i2), approx5(st), approx5(o)
  from t where private.my_role() = 'employer';
$$;
revoke all on function employer_supply(text) from public;
grant execute on function employer_supply(text) to authenticated;
-- A hidden count comes back as null; the API shows it as "<5".
