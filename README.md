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

## Tech stack

- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`) — a single file, no external service
- **Auth:** JWT bearer tokens, bcrypt-hashed passwords
- **Frontend:** dependency-free vanilla JS (no build step)

## Getting started

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
