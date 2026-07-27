# Daily Reporting

A self-hosted web app for collecting daily reports from employees — a
customisable, role-aware replacement for Microsoft Forms.

Admins build questionnaires, assign each one to specific employees, and hand out
a **unique code** per assignment. An employee opens the site, types their code,
answers the questions meant for *them*, and submits. Managers assign tasks (with
notifications), and everyone can review the data they're allowed to see.

## What it does

- **Role-based access**
  - **Admin** — full control: departments, users, questionnaires, assignments, all reports, tasks.
  - **Department head** — everything scoped to their own department (their team's users, questionnaires, reports and tasks).
  - **Employee** — submits reports, sees only their own reports, works their assigned tasks, receives notifications.
- **Custom questionnaires** — build forms with short/long text, numbers, dates, dropdowns, single- and multi-choice questions; mark any as required.
- **Per-employee assignment with unique codes** — the same questionnaire can go to many people, and different people can get different questionnaires. Each assignment gets a unique code (e.g. `9EKS-BNCF`) that opens exactly that report. Codes can be copied, regenerated, or revoked.
- **Code-based reporting (no login needed to report)** — employees just enter their code. Logging in is only needed to browse historical data.
- **Tasks & notifications** — admins/heads assign tasks; the assignee gets a notification and can move it through pending → in progress → done. The assigner is notified on completion.
- **Own-data access** — employees see the reports they submitted; heads see their department; admins see all.
- **Export** — download the reports you're allowed to see as CSV (drop-in point for Google Drive sync — see below).

## Two ways to run it

This repo ships the same app in two forms — pick one:

| | **Firebase** (in `web/`) | **Self-hosted** (in `server/` + `public/`) |
|---|---|---|
| Hosting | Firebase Hosting (static) | Any Node host (Fly.io, a VPS…) |
| Backend | None — the browser talks to Firestore directly | Node.js + Express |
| Database | Firestore | SQLite |
| Auth | Firebase Auth | JWT + bcrypt |
| Access control | **Firestore security rules** (`firestore.rules`) | Enforced in Express routes |
| Cost | Free (Spark plan, no card) | Host-dependent |

If you're deploying to Firebase, use the **[Deploy to Firebase](#deploy-to-firebase)**
section below and you can ignore the `server/` directory. The two share nothing
at runtime — they're independent implementations of the same product.

## Getting started (self-hosted version)

```bash
npm install

# Optional: seed a full demo (departments, users, questionnaires, codes)
npm run seed -- --demo

npm start
# → http://localhost:3000
```

On first run against an empty database, a bootstrap admin is created:

```
email:    admin@example.com
password: admin123
```

Change this immediately (Users → edit), or set `ADMIN_EMAIL` / `ADMIN_PASSWORD`
before the first run. See `.env.example` for all configuration.

### Demo accounts (after `npm run seed -- --demo`)

| Role        | Email                | Password      |
|-------------|----------------------|---------------|
| Admin       | admin@example.com    | admin123      |
| Dept head   | erin@example.com     | password123   |
| Employee    | alice@example.com    | password123   |
| Employee    | bob@example.com      | password123   |
| Employee    | carol@example.com    | password123   |

The seed prints each employee's assignment code — use one on the front page to
try the reporting flow without logging in.

## Typical workflow

1. **Admin** creates departments and users, optionally naming a department head.
2. **Admin/head** builds a questionnaire and clicks **Assign & codes** to assign it to specific employees. Each employee gets a unique code.
3. The **employee** opens the site, enters their code, fills in *their* questions, and submits.
4. **Admin/head** reviews reports (scoped to what they're allowed to see) and can export CSV.
5. **Admin/head** assigns tasks; the employee is notified and updates the status.

## Project layout

```
server/
  index.js            Express app + static hosting + SPA fallback
  db.js               SQLite connection + schema migration
  auth.js             password hashing, JWT, role middleware, code generation
  seed.js             bootstrap admin + optional demo data
  routes/
    auth.js           login, current user
    departments.js    department CRUD (admin)
    users.js          user CRUD (admin; heads add employees to their dept)
    questionnaires.js questionnaire + nested questions CRUD
    assignments.js    assign questionnaires to users, issue/revoke codes
    public.js         unauthenticated code lookup + submission
    reports.js        role-scoped report viewing + CSV export
    tasks.js          task assignment + status, notifications on change
    notifications.js  list / mark-read
public/
  index.html, styles.css, app.js   single-page frontend
```

## API overview

| Method | Path                              | Who | Purpose |
|--------|-----------------------------------|-----|---------|
| POST   | `/api/auth/login`                 | all | Log in, receive JWT |
| GET    | `/api/departments`                | auth | List departments (scoped) |
| POST/PUT/DELETE | `/api/departments[/:id]` | admin | Manage departments |
| GET/POST/PUT/DELETE | `/api/users[/:id]`   | admin / head | Manage users (heads: own dept employees) |
| GET/POST/PUT/DELETE | `/api/questionnaires[/:id]` | admin / head | Manage questionnaires |
| GET/POST | `/api/assignments`              | admin / head | List / create assignments (codes) |
| POST   | `/api/assignments/:id/regenerate` | admin / head | Issue a new code |
| POST   | `/api/report/lookup`              | public | Resolve a code → questionnaire |
| POST   | `/api/report/submit`              | public | Submit answers for a code |
| GET    | `/api/reports`                    | auth | List reports (scoped) |
| GET    | `/api/reports/:id`                | auth | One report with answers |
| GET    | `/api/reports/export/csv`         | auth | Export visible reports as CSV |
| GET/POST/PATCH/DELETE | `/api/tasks[/:id]` | auth | Tasks (create: admin/head) |
| GET    | `/api/notifications`              | auth | List notifications |
| POST   | `/api/notifications/read-all`     | auth | Mark all read |

## Data storage & Google Drive

Reports are stored in SQLite (`data/reporting.db`) as the source of truth, and
can be exported to CSV per role scope via `/api/reports/export/csv`. This CSV
export is the intended integration point for pushing data to an external store
such as **Google Drive**: a scheduled job (or a hook on submission in
`routes/public.js`) can upload the export to a Drive folder per department, so
each team's data lands somewhere only they can access. Wiring up Google Drive
OAuth and the Drive API is left as a deployment-specific follow-up; the export
endpoint and per-role scoping are already in place to build on.

## Deploy to Firebase

The `web/` directory is a self-contained Firebase app: **Firebase Hosting** for
the frontend, **Firebase Auth** for login, and **Firestore** for data. There is
no server — all access control is enforced by the security rules in
`firestore.rules` (validated by an emulator test suite covering role scoping,
the public code flow, and privilege-escalation guards). This runs on the free
**Spark plan** (no credit card).

### 1. Create the Firebase project

1. Go to the [Firebase console](https://console.firebase.google.com) → **Add project**.
2. **Build → Authentication → Get started → Email/Password → Enable.**
3. **Build → Firestore Database → Create database** (start in production mode; the rules below lock it down).

### 2. Connect this repo

1. Install the CLI and log in:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
2. Put your project id in `.firebaserc` (replace `YOUR_FIREBASE_PROJECT_ID`), or run `firebase use --add`.
3. Paste your web config into `web/firebase-config.js` — get it from
   **Project settings → General → Your apps → Web app** (create a web app if you
   don't have one). These values are not secrets.

### 3. Deploy

```bash
firebase deploy --only firestore:rules,hosting
```

Your app goes live at `https://YOUR_PROJECT_ID.web.app`.

### 4. Create the first admin (one-time bootstrap)

Because there's no server seed, create the very first admin by hand:

1. **Authentication → Users → Add user** — enter the admin's email + password.
   Copy the generated **User UID**.
2. **Firestore Database → Start collection** named `users`. Add a document whose
   **Document ID is that UID**, with fields:
   - `name` (string) — e.g. "Administrator"
   - `email` (string) — the same email
   - `role` (string) — `admin`
   - `authUid` (string) — the same UID
   - `departmentId` (string, or leave null)
3. Open the site, click **Staff / admin login**, and sign in. From there the
   admin creates departments, users, questionnaires, assignments, and tasks —
   no more console work needed.

### How users and reporting work

- **Adding a user** captures a **Name** and a **Unique ID** (you choose it, e.g.
  `EMP001`), plus an optional Department and Role. A **login (email + password)
  is optional** — fill it only for people who need the dashboard (admins and
  department heads require one; reporters usually don't).
- **Reporting needs only the Unique ID.** An employee opens the site, types their
  Unique ID, sees the questionnaire(s) assigned to them, and submits — no login.
- **Assigning** a questionnaire to someone just links it to them; their single
  Unique ID covers every questionnaire they're assigned.
- Anyone you gave a login to can also sign in to see their own past reports.

### Tasks (with long-horizon pendency)

Admins and department heads assign tasks to any user; each task shows up
automatically in that person's reporting flow (by Unique ID) and, if they have
a login, on their dashboard. Two kinds:

- **One-time** — the person marks it **Completed** (records the date and closes
  it) or **Still pending** (with a reason).
- **Quantity / pendency** — for long-horizon backlogs. The task has an optional
  horizon (e.g. 15 days) and a starting pending count. Each day the person
  enters what they **Completed** and what was **Newly added**, and the running
  pending recalculates as `previous − completed + added`, carried forward and
  shown on the next report. It auto-closes when pending reaches 0.

Every change is written to an audit log, so managers can open a task's
**History** to see the day-by-day completed/added/pending trail.

### Automated deploy from GitHub (no command line)

For a phone-only / no-PC workflow, `.github/workflows/firebase-deploy.yml`
deploys the rules and frontend automatically whenever `main` changes. Set it up
entirely in the browser:

1. **Firebase console → Project settings (gear) → Service accounts →
   Generate new private key.** This downloads a JSON file. If deploys later fail
   with a permissions error, grant that service account the **Editor** role in
   Google Cloud console → IAM.
2. **GitHub → your repo → Settings → Secrets and variables → Actions →
   New repository secret.** Name it exactly `FIREBASE_SERVICE_ACCOUNT` and paste
   the entire contents of that JSON file as the value.
3. Using GitHub's web editor (the pencil icon), fill in `web/firebase-config.js`
   and `.firebaserc` with your real values, and commit.
4. Merge to `main` (e.g. merge the pull request). The merge triggers the
   workflow and deploys; watch it under the repo's **Actions** tab. After the
   first run you can also redeploy anytime with **Actions → Deploy to Firebase →
   Run workflow.**

Then do the one-time admin bootstrap (step 4 above) and you're live.

### Local testing with the emulator

```bash
firebase emulators:start
```

serves Hosting + Firestore locally so you can try everything before deploying.

> **Note on user deletion:** removing a user in the app deletes their Firestore
> profile (which revokes all access). Their Firebase **Auth** login still exists
> until you also remove it under **Authentication → Users** — deleting Auth
> accounts requires admin privileges the browser can't hold.

## Deploy to Fly.io (self-hosted version)

The repo ships a `Dockerfile` and `fly.toml` ready for [Fly.io](https://fly.io),
which runs the app as-is and keeps the SQLite database on a **free persistent
volume** (data survives restarts and deploys).

1. **Install flyctl and sign in:**
   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth signup      # or: fly auth login
   ```

2. **Pick a globally-unique app name** and set it in `fly.toml` (`app = "..."`).
   Adjust `primary_region` to a region near you if you like (default: `bom`,
   Mumbai). Run the remaining commands from the repo directory so flyctl reads
   `fly.toml`.

3. **Create the app and its database volume** (region must match `fly.toml`):
   ```bash
   fly apps create your-app-name
   fly volumes create data --region bom --size 1
   ```

4. **Set a strong token secret** (and optionally the admin password):
   ```bash
   fly secrets set JWT_SECRET=$(openssl rand -hex 32)
   fly secrets set ADMIN_PASSWORD=your-strong-password
   ```

5. **Deploy:**
   ```bash
   fly deploy
   ```

Your app goes live at `https://your-app-name.fly.dev`. On first boot the
bootstrap admin is created (`admin@example.com` / the `ADMIN_PASSWORD` you set,
or `admin123` by default) — log in and change it immediately.

**Notes**
- The volume must exist **before** the first deploy (step 3), because `fly.toml`
  mounts it at `/app/data`.
- `min_machines_running = 0` scales the app to zero when idle to conserve the
  free allowance; the first request after idle cold-starts in a few seconds. Set
  it to `1` in `fly.toml` to keep it always warm.
- Because the database is a single SQLite file on one volume, run a single
  machine (don't scale to multiple instances).

> **Why not GitHub Pages / Firebase Hosting?** Those host static files only and
> cannot run this Node server or its database. This app needs a host that runs
> Node with a persistent disk — hence Fly.io (or Render/Railway/a VPS).

## Configuration

All optional — see `.env.example`:

- `PORT` — HTTP port (default `3000`)
- `JWT_SECRET` / `JWT_TTL` — token signing secret and lifetime (**set a strong secret in production**)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — bootstrap admin (empty DB only)
- `DATA_DIR` / `DB_PATH` — where the SQLite file lives

## Security notes

- Set a strong `JWT_SECRET` and change the default admin password before deploying.
- Serve behind HTTPS (e.g. a reverse proxy) in production.
- Assignment codes are unguessable but shareable — treat them like the report link they are; regenerate a code to revoke access.
