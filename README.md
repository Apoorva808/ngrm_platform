# NGRM Platform: pilot build

Working frontend and backend for the National Graduate Readiness Mission pilot. It covers an explainable readiness score,
a plan the student controls, mentor review, college cohort views, and aggregated employer insight.

The goal is a pilot that a university can run with real students once the items under "Before real students" are done.

## Run it

Requires Node.js 22.13 or newer (tested on 22.13, 22.23 and 24). Nothing else is needed: the local database is built into Node.

```bash
npm install
cp .env.example .env      # demo settings are already on
npm start                 # http://localhost:3000
npm test                  # 74 tests
npm run seed              # wipe and reload the sample data
```

The first start creates `data/ngrm.sqlite` and loads sample data. All names, colleges and employers in it are invented.

## Demo accounts

With `DEMO_MODE=true` the sign-in page shows one-click accounts. All end in `@demo.ngrm.in`.

| Account | Role | What to try |
|---|---|---|
| ananya@ | Student (BA Psychology, year 2, aiming for HR) | Score, plan, accept or decline steps, add evidence, export or delete data |
| kavya@ | Mentor | Review queue, approve or comment on plans, verify evidence, record college assessment results, cohort view |
| placement@ | College placement cell | Cohort readiness by programme (groups under 5 hidden), students interested in introduction requests |
| recruiter@ | Employer | Skill supply by college, post demand, request introductions, see how many replied |
| research@ | Researcher | Pseudonymous export of students who agreed to the study |
| admin@ | Admin | Add colleges, employers and people; switch rules on or off, adjust thresholds; audit log |

The other sample students (`student1@sample.ngrm.in` onwards) fill the totals; they have no passwords. An admin can give any of them one with "Reset password".

**Sign-up and sign-in use an email and a password. No codes are sent.**

- **Sign-up.** Anyone can create an account on the sign-up page with their name, email and a password. Students choose their college from the list and are in straight away. Mentors, placement cells, employers and researchers can sign up too, but their account waits on the Admin page until an admin approves it, because those roles see information about students. Admin accounts are never created by sign-up. Set `SIGNUP=off` to close sign-up, and `SIGNUP_DOMAINS` to limit student sign-up to college email addresses.
- **Admin-added accounts.** An admin can add people on the Admin page, one per line: `name, email, role, college or employer, mentor email`. Nothing is saved if any line has a mistake. Each new person gets a temporary password, shown once to the admin to hand over; the person must choose their own at first sign-in.
- **Forgotten password.** The admin clicks "Reset password" beside the person and hands over the new temporary password. The old one stops working and open sessions end.
- **Passwords** are stored only as salted scrypt hashes, need at least 10 characters, refuse common choices, and lock for 15 minutes after five wrong tries.
- **What this does not check.** With no code, nothing proves that a person owns the email they type. Someone could sign up as a student with another person's address. Staff roles are protected by admin approval; for students, set `SIGNUP_DOMAINS` and have mentors confirm who their students are. To add an emailed 6-digit code at sign-up (and as a second way to sign in and reset a password), set `EMAIL_CODES=on` with `MAIL_FROM` and a Brevo or Resend key.

Codes are limited to one every 30 seconds and five an hour per email, and lock after five wrong tries.
Admins can search for an account and remove it (for example when someone leaves or asks to be erased). A mentor's past reviews stay with the student.

## How it is built

```
server/
  index.js     start-up, .env loading, refuses unsafe production settings
  app.js       all API routes, role checks, consent checks, audit logging
  domain.js    scoring formula v0.3, bands, rule library, what-if projections
  auth.js      passwords, sign-up, sessions (and optional email codes)
  ai.js        optional Gemini rewording, with a safety check
  db.js        SQLite helpers
  schema.sql   local database tables
  seed.js      invented sample data
public/        nine pages (plain HTML, CSS, JavaScript, no build step)
db/postgres/   production database scripts for Supabase, with row-level security
test/          scoring and API tests
```

One dependency (Express). The scoring and rules live on the server only, so the browser cannot change a score.

## How the five pilot rules are enforced

1. **Same answer every time.** The score is a fixed formula (`server/domain.js`, version `v0.3`). Every saved score stores its inputs, each factor and the formula version, so any number can be traced and re-checked. Students can attach a proof file (PDF, PNG or JPEG, up to 5 MB); only the student and their own mentor can open it, and it is deleted with the item or the account. Evidence counts only once a mentor has verified it. A mentor records college assessment results (a role skill or communication); that score is then locked and the student cannot change or delete it.
2. **Students decide.** Recommendations come from a rule library, ranked by how much each would raise the score. Students accept or decline each one. A mentor cannot override a decline (the API returns 409).
3. **Consent first.** Each use needs its own consent: profile, personality questions, AI wording, employer introductions, research study. Under-18s must name a guardian, and that status is kept on every later consent change. Consent can be withdrawn and is stored as a history. Withdrawing questionnaire consent removes the answers everywhere, including earlier recorded scores and the study baseline. Questionnaire results are saved only when the student has set all five traits; nothing is filled in for them.
4. **No individual data for employers or colleges.** Employers and placement cells see counts only. Any group under 5 is hidden, and employer counts are rounded to the nearest 5 so one total cannot be subtracted from another to find a small group. Colleges never see programmes with fewer than 5 students, for the same reason, and college counts are also rounded to 5, averages to whole numbers, and percentages shown only when both sides have 5 or more students, so comparing views over time cannot reveal one student. Introduction requests need at least 5 students who opted in. Students who opted in see the request and choose "I'm interested"; only their own placement cell then sees their name, and puts them in touch. The employer sees only how many replied.
5. **Everything is logged and reversible.** Sign-ins, score runs, consent changes, reviews, verifications, exports and deletions are written to an audit log. Students can download all their data or delete their account.

AI is optional. When switched on (`GEMINI_API_KEY` and the student's AI consent), Gemini only rewords the reason for a step. The new wording is rejected if it adds a number, a link or changes length too much, and the original is used instead. AI never changes a score or a ranking.

## Scoring formula v0.3

Eight factors: academic 20, technical/role skills 20, projects 15, experience 15, personality 10, communication 10, leadership 5, career clarity 5.

- **What a student types about themselves does not count until confirmed.** A CGPA counts only after the mentor confirms it against college records (the mentor enters the figure; a later change by the student sends it back for confirmation). Each of the four role skills counts only after a college assessment the mentor records; a skill not yet assessed counts as 0, so each assessment can only add. The student's own ratings still shape the plan. The plan's first step tells the student what is waiting, and the mentor's page lists it per student. Employers' skill totals use assessed skills only.
- **Unanswered is left out, never guessed.** A factor with no answer (CGPA not entered or not yet confirmed, personality not entered or consent withdrawn, communication not yet assessed, clarity not rated) is "not yet rated". The score is the weighted average of the rated factors, and the page shows what share of the formula it covers.
- **Limits against flooding.** A student can have at most 10 evidence items waiting for a mentor and 60 in total. An employer can post at most 3 requirements and 500 openings per role in 90 days, and can withdraw a post. Passwords need 10 characters and common ones ("password123") are refused. A CGPA outside 0 to 10 is refused, not adjusted.
- **Research export.** Pseudonyms, month-only dates, scores rounded to 5, CGPA-based score in wide bands. Where fewer than 5 participants share a programme, year and target role, the role, then year, then programme is withheld; rare CGPA bands are withheld too. This costs detail: in the sample data about a third of records keep their target role and about a quarter keep their academic band.
- **Only verified evidence counts.** Projects score 35 each, internships 50 each, leadership roles 50 each, capped at 100, and only after a mentor verifies them. With none verified these factors are 0.
- **Communication** comes only from a college assessment a mentor records. Students cannot enter it.
- **CGPA and career clarity** can be corrected but not cleared once entered, so a low value cannot be hidden.
- **Known limit.** Because unanswered factors are left out, a student who never enters personality results (or withdraws that consent) is scored without it, which can be higher or lower than with it. Completeness is shown beside every score so mentors can see this.
- Every recorded score stores its inputs and formula version. Scores recorded under v0.1 or v0.2 keep that label.

## Real courses and live updates

- **Checked courses.** The step for a student's weakest skill names real courses with links (NPTEL/SWAYAM, Kaggle, freeCodeCamp, Coursera, Google, HubSpot, Poynter, Figma). The starter list is in `server/courses.js`; each title and link was checked on 10 Nov 2026. Admins add and remove courses on the Admin page, and students see changes at once. Providers move and retire courses, so open the links at the start of each semester.
- **Live search.** Each course step also links to a live search for that exact skill on SWAYAM, Class Central and Coursera, so students always see what is running now. Admins can change the sites.
- **Live screens.** The plan, evidence, mentor queue and employer pages refresh on their own every 30 seconds (paused while someone is typing or the tab is hidden).
- **Live course feed.** Each course step also lists courses fetched from Coursera's catalogue for that exact skill, refreshed once a day per skill. Only the skill name is sent. The Admin page shows whether the feed is working and has a test box. If the feed is down or changes, students still see the checked courses and search links. Set `COURSE_FEED=off` to switch it off. This feed was built and tested against a stand-in; confirm it on the hosted site with the test box, and check Coursera's terms before relying on it.
- **Skills in demand.** The plan page ranks the skills partner employers are asking for (openings in the last 90 days) against the student's own level, and the course step says when its skill is in demand. This is demand posted on NGRM, not a national job count.
- **Live activity.** Admins see people active today, sign-ins, student actions, evidence waiting, and a 14-day chart, exact and without names. Placement cells see their own college's last 7 days, hidden under 5 and rounded to 5.
- **Not included.** There is no feed from SWAYAM (no public feed we could rely on) and no outside job-market data: the open jobs feed we looked at (Adzuna) restricts republishing its data in aggregated form without written consent. Demand shown to students is what employers post on this platform.

## Quality checks done

- 74 automated tests (`npm test`) covering scoring, sign-in limits, access between roles, consent, small-group protection, introductions, assessments, admin tools, data rights, and the AI wording path (with a stand-in for Google's service).
- The tests pass on Node 22.13, 22.23 and 24. Node 22.12 and older cannot run the built-in database, and the server says so.
- A browser walk-through of every page for all six roles (133 checks), at desktop and phone widths, with no server errors.
- An automated accessibility scan (axe-core, WCAG 2.1 AA) of every page in normal and high-contrast mode: no violations. Keyboard-only use works.
- Speed with 20,000 extra students: every page answers in under 0.2 seconds.
- The Postgres scripts were applied to Postgres 16 and their access rules tested role by role.

- An independent review by a separate reviewer who had not seen the build. All of its confirmed findings are fixed and covered by tests.

Not yet tested, because they need real services: email delivery, the live Gemini service, hosting, and a review with screen-reader users.

## Main API routes

| Area | Routes |
|---|---|
| Sign-in | `POST /api/auth/sign-up`, `POST /api/auth/sign-up/verify`, `POST /api/auth/request-code`, `POST /api/auth/verify`, `POST /api/auth/password`, `POST /api/me/password`, `POST /api/admin/users/:id/reset-password`, `POST /api/auth/sign-out`, `GET /api/me` |
| Student | `GET/PUT /api/me/profile`, `POST /api/me/score`, `GET /api/me/score-history`, `GET/POST/PATCH/DELETE /api/me/evidence`, `GET/POST /api/me/intro-requests`, `GET /api/me/recommendations`, `PATCH /api/me/recommendations/:ruleId`, `GET/POST /api/me/consents`, `PATCH /api/me/intro-opt-in`, `POST /api/me/baseline`, `GET /api/me/export`, `DELETE /api/me` |
| Mentor | `GET /api/mentor/mentees`, `GET /api/mentor/queue`, `POST /api/mentor/assessments`, `PATCH /api/mentor/reviews/:studentId/:ruleId`, `POST /api/mentor/evidence/:id` |
| College | `GET /api/college/cohort?programme=`, `GET /api/college/intro-requests` |
| Employer | `GET /api/employer/supply?role=`, `POST /api/employer/demand`, `DELETE /api/employer/demand/:id`, `GET/POST /api/employer/intros`, `GET /api/demand` |
| Research | `GET /api/research/export` |
| Admin | `GET /api/admin/people?q=`, `POST /api/admin/orgs`, `POST /api/admin/users`, `DELETE /api/admin/users/:id`, `GET /api/admin/audit`, `GET /api/admin/rules`, `PATCH /api/admin/rules/:id` |

## Settings (.env)

| Name | Meaning |
|---|---|
| `PORT` | Port, default 3000 |
| `SESSION_SECRET` | Long random string. Required in production |
| `DEMO_MODE` | One-click sample accounts. Must be `false` in production |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | The first admin account. `ADMIN_PASSWORD` is the password for the first sign-in; the admin is then asked to choose their own, and the setting is ignored from then on |
| `EMAIL_CODES` | `on` adds emailed 6-digit codes (to confirm an email at sign-up and as a second way to sign in). Needs the mail settings below. Default: off, password only |
| `DEV_SHOW_OTP` | With `EMAIL_CODES=on`, shows codes on screen for testing. Must be `false` in production |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional AI rewording |
| `DB_FILE` | Local database path |
| `MAIL_FROM`, `RESEND_API_KEY` or `BREVO_API_KEY` | Optional. Sends the codes when `EMAIL_CODES=on`, and a note to staff when their sign-up is approved |
| `SIGNUP` | `off` closes sign-up, so only admins add accounts. Default: open |
| `SIGNUP_DOMAINS` | Optional. Comma-separated email domains students must sign up with, for example `college.edu.in` |
| `COURSE_FEED` | `coursera` (default) or `off`. Controls the live course feed |
| `UPLOAD_DIR` | Where proof files are kept. Default: an `uploads` folder beside the database |
| `ORG_NAME`, `PRIVACY_CONTACT` | Required in production. Shown on the privacy notice: who runs the pilot and whom to write to |
| `NODE_ENV` | Set to `production` when live. The server will not start in production with demo settings on |
| `ADMIN_EMAIL`, `ADMIN_NAME` | Production: the first admin account, created on start-up. Production starts with no sample people |
| `TRUST_PROXY` | `true` when running behind a hosting proxy, so the per-network sign-in limit sees real visitor addresses |
| `SEED_SAMPLE` | `true` only for a public demo server that should load the sample data in production mode |

## Moving to production (Supabase)

`db/postgres/001_schema.sql` and `002_rls.sql` are the production version of the database for Supabase.
Students can only add consent rows (never edit or delete the history), and profile changes, scores, reviews and verifications go through the API. Helper checks sit in a `private` schema that Supabase does not publish. They have been applied to Postgres 16 and tested: a student sees only their own rows, a mentor sees only their mentees,
an employer and a placement cell see no student rows, students cannot mark their own evidence as verified or reply on
someone else's behalf, a placement cell sees introduction replies only from its own college, and the employer supply
function hides groups under 5 and rounds the rest.

Changing a target role clears that student's accepted steps and mentor reviews, since the plan is for a different role.

Steps: create the Supabase project in the Mumbai region, run the two scripts, switch sign-in to Supabase Auth,
and replace `server/db.js` queries with Supabase calls. The API routes and pages stay the same.

## Before real students

- Decide whether to turn on emailed codes (`EMAIL_CODES=on`) so that sign-up proves the person owns the email. Without it, set `SIGNUP_DOMAINS` and rely on mentors knowing their students.
- Hosting in India, HTTPS, backups, and rate limits on sign-in.
- Legal review of consent text and privacy notice against the DPDP Act 2023 and its Rules, including guardian consent.
- Ethics approval for the research study, and university data-sharing agreements.
- Validation of the score weights with the pilot cohort before any decisions rely on them.
- Later: DigiLocker and APAAR linking for verified credentials.

## Launching the pilot with real students

`render.yaml` sets up the live pilot. You need two accounts: GitHub (done) and Render.

1. **Host.** On render.com choose New > Blueprint and pick this repository. Fill in what it asks for: `ORG_NAME` (who runs the pilot), `PRIVACY_CONTACT` (an email students can write to), `ADMIN_EMAIL` and `ADMIN_NAME` (you), and `ADMIN_PASSWORD` (a password for your first sign-in). It needs the Starter plan, because the disk keeps the database and proof files.
2. **Sign in.** Open the site and sign in with your admin email and `ADMIN_PASSWORD`. You are asked to choose your own password straight away.
3. **Add colleges.** On the Admin page add each college (students can only sign up to a listed college), then add or approve mentors and link students to mentors.
4. **Read the privacy notice** at `/privacy.html` and edit `public/privacy.html` if anything differs from how you will run the pilot (retention, contact, who the responsible organisation is).
5. **Tell students** the address. They create an account with their email and a password, read the notice, and choose their consents.
6. **Tell mentors** that a student's CGPA and skills count only after they confirm them on the mentor page.

The server refuses to start in live mode without the operator name, privacy contact and a strong session secret. Keep backups: check your host's disk snapshot settings before students start, and take a copy of `/data` before any upgrade.

## Hosting a demo

The repository includes a `Dockerfile` and a Render blueprint (`render.yaml`).

1. Put this folder in a GitHub repository.
2. On render.com choose New > Web Service, pick the repository, choose the Free instance type, and add `DEMO_MODE=true`. Data resets whenever the free service sleeps or restarts.
3. Open the address Render gives you. The sign-in page shows the sample accounts.

This runs in demo mode with sample data. Any host that runs Docker with a persistent volume mounted at `/data` works the same way (Railway, Fly.io, a VPS). Before real students use it, follow "Before real students": production mode and the legal checks.
