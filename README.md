# Daily Consultant Reports

A free, mobile-first web app that replaces WhatsApp daily reports.

- **Consultant link** (`index.html`): register once with name and mobile, then submit a daily report with formatted text and photos. The server records the date and time. Consultants cannot read any reports.
- **Dashboard** (`dashboard.html`): the manager and the admin sign in to see today's status, filter reports, export PDF and Excel, manage projects and consultants, and archive old reports to a computer.

Everything runs on free tiers: GitHub Pages hosts the static site, and Supabase (free plan) provides the database, photo storage and sign-in. There is no build step: the site is plain HTML, CSS and ES modules, with libraries loaded from jsDelivr / cdn.sheetjs.com at pinned versions.

> Deliberate differences from the specification are listed in [DEVIATIONS.md](DEVIATIONS.md).
> The Arabic user guide for the manager is in [docs/manager-guide-ar.md](docs/manager-guide-ar.md).

---

## 1. Project layout

```
index.html                 Consultant app
dashboard.html             Dashboard (manager + admin)
css/                       base.css (palette, controls), consultant.css, dashboard.css, card.css (report card / PDF)
fonts/                     Inter + Noto Naskh Arabic (self-hosted woff2)
js/config.js               Supabase URL + publishable key, limits  ← the only file to edit when moving projects
js/i18n.js                 All UI strings (en / ar)
js/lib.js                  Supabase client, Riyadh dates, mobile normalisation, file names
js/sanitize.js             Report HTML allow-list (DOMPurify)
js/consultant.js, idb.js   Consultant app (draft text in localStorage, draft photos in IndexedDB)
js/dashboard/*.js          One module per dashboard screen
js/export/*.js             card (shared layout), pdf, excel, archive, data (queries)
supabase/migrations/*.sql  Schema, functions, RLS + storage, seed data
.github/workflows/keepalive.yml
```

## 2. Owner setup checklist

The current build is already connected to the Supabase project **Daily Consultant Reports** (`klhqyozldjtnduopsouc`, region eu-central-1). The migrations are applied and three sample projects exist. Steps 1–3 only matter if you ever move to a new Supabase project.

1. **Create a free Supabase project** at <https://supabase.com/dashboard> and copy the *Project URL* and the *publishable* (anon) key from *Project Settings → API Keys*.
2. **Run the SQL files** in `supabase/migrations/` in order (001 → 004) in *SQL Editor*. Migration 003 also creates the private `report-photos` bucket (1 MB per file, JPEG only).
3. **Put the URL and key in `js/config.js`** (`SUPABASE_URL`, `SUPABASE_KEY`). Never put the `service_role` / secret key anywhere in this repository.
4. **Lock down sign-ups** (important): *Authentication → Sign In / Providers → Email* → turn **off** “Allow new users to sign up”. Staff accounts are created only by you. (A self-registered account would see nothing because of RLS, but there is no reason to allow it.)
5. **Create the manager and admin accounts**: *Authentication → Users → Add user → Create new user*, enter the email and a password, tick *Auto Confirm User*. Do this once for the manager and once for yourself (admin).
6. **Give them their roles** in *SQL Editor* (replace the emails):

   ```sql
   insert into public.profiles (user_id, role, display_name)
   select id, 'admin', 'Owner' from auth.users where email = 'owner@example.com';

   insert into public.profiles (user_id, role, display_name)
   select id, 'manager', 'Manager' from auth.users where email = 'manager@example.com';
   ```

   An account without a `profiles` row cannot use the dashboard.
7. **Set the Auth URLs** so password-recovery emails open the dashboard: *Authentication → URL Configuration* → *Site URL* = `https://<your-user>.github.io/<repo>/dashboard.html`.
8. **Create the GitHub repository** (it must be **public** for free GitHub Pages) and push this folder:

   ```bash
   git init -b main
   git add .
   git commit -m "Daily Consultant Reports"
   git remote add origin https://github.com/<your-user>/<repo>.git
   git push -u origin main
   ```

9. **Enable GitHub Pages**: repository *Settings → Pages → Build and deployment → Source: Deploy from a branch*, branch `main`, folder `/ (root)`.
10. **Add the keep-alive secrets**: *Settings → Secrets and variables → Actions → New repository secret*:
    - `SUPABASE_URL` = `https://klhqyozldjtnduopsouc.supabase.co`
    - `SUPABASE_ANON_KEY` = the publishable key from `js/config.js`

    Then open *Actions → keep-alive → Run workflow* once and check it goes green.
11. **Share the links**:
    - Consultants (WhatsApp group): `https://<your-user>.github.io/<repo>/`
    - Manager: `https://<your-user>.github.io/<repo>/dashboard.html`

The repository is public, so the code is visible to anyone. That is fine: the only key in it is the publishable key, which is designed to be public — all protection is enforced by Row Level Security in the database.

## 3. How security works

| Who | Can do | Enforced by |
|---|---|---|
| Anyone with the consultant link (`anon`) | Read **active** projects; call `register_consultant`, `update_my_details`, `submit_report`, `attach_photos`, `heartbeat_ping`; upload a JPEG only into the folder of a report created in the last 2 days, up to the number of photos that report declared | RLS + `SECURITY DEFINER` functions; storage policy `private.can_upload_photo()` |
| Anyone with the link | **Cannot** read, list, overwrite or delete any report, consultant, photo or setting | RLS, table grants revoked |
| Manager | Everything in the dashboard except the Admin section | `profiles.role = 'manager'` checked by `is_staff()` |
| Admin | Also reads/edits `app_settings` (link protection) | `is_admin()` in RLS |

Additional server-side safeguards (always on, invisible to consultants):

- Consultants never write to tables directly; every write goes through a function that validates the input.
- Registering an existing mobile never overwrites the stored name.
- `submitted_at` is set by the server and a trigger blocks any change to it, to the report text or to the consultant snapshot.
- Report text is limited to 200,000 characters, photos to 20 per report and 1 MB each (the app compresses to ~300 KB), and 20 reports per consultant per day (changeable in Admin).
- Report HTML is sanitised with an allow-list before saving and again before display/PDF.

### Consultant-link protection (Admin → Consultant link protection)

The specification leaves this open, so it is built in and **switched off** (`none`). The admin can switch it at any time, without code changes:

| Mode | Effect |
|---|---|
| `none` (default) | Anyone with the link can register — as the spec describes. |
| `team_code` | Registration requires a shared team code (share it with the link). |
| `team_code_device` | As above, and reports are accepted only from the phone that registered. If a consultant changes phones, the manager taps **Allow new phone** on the Consultants screen, then the consultant registers again on the new phone. |

Every registration already receives a secret device token (stored on the phone), so switching to `team_code_device` later works for existing consultants without re-registering.

## 4. Operations

### Daily
Nothing. Consultants submit; the manager checks **Today**.

### Keep-alive (Supabase free projects pause after ~7 days without activity)
`.github/workflows/keepalive.yml` runs every day at 06:17 Riyadh time and calls `heartbeat_ping()` with the publishable key. The **Admin** screen shows the last ping and warns if it is older than 3 days.

GitHub disables scheduled workflows in repositories with no commits for 60 days. To prevent that, the same job commits a one-line timestamp file (`.github/keepalive.txt`) **only when the last commit is 45+ days old** — at most about eight small commits a year, and none while you are actively committing. Each such commit also republishes GitHub Pages, which is harmless.

If the project did pause anyway: Supabase dashboard → the project → **Restore project**, then run the workflow manually.

### Storage and archiving
- Free plan: **1 GB photo storage** and **500 MB database** (separate quotas). The **Storage & Archive** screen shows both; warnings appear at 80% and 95%.
- Rough estimate: 15 consultants × 5 photos × ~300 KB ≈ 22 MB/day → photo storage fills in about **6–7 weeks**. Plan to archive roughly **once a month** (“Oldest month”).
- Archiving must be done on a **computer** (Chrome or Edge). The browser builds `Archive_<from>_to_<to>.zip` containing the PDF, the Excel file and all photos in `Photos/<Consultant>/<YYYY-MM-DD>/<HHmm>_<Project>_<n>.jpg`. Ranges larger than ~400 MB are split into several ZIPs automatically.
- Nothing is deleted until the manager ticks “I have saved the archive file…” and types `DELETE`. If building the ZIP fails, nothing is deleted. If the deletion itself is interrupted (e.g. network), the screen offers **Continue deletion** next time.
- Monthly transfer (egress) on the free plan is 5 GB. Viewing report details, exporting PDFs and archiving all download photos, so avoid exporting very large PDFs repeatedly.

### Reset the manager's password
Supabase dashboard → *Authentication → Users* → the manager → **Send password recovery** (or **Reset password** to set one directly). The Admin screen has a direct link.

### Changing projects
Use **Projects** in the dashboard: add, edit, deactivate. Names that consultants typed under **Other** appear at the bottom with **Add to project list**, which can also re-link the past reports that used exactly that name.

## 5. Local development

Any static server works, for example:

```bash
python -m http.server 8610
```

Then open <http://localhost:8610/> (consultant) and <http://localhost:8610/dashboard.html>. The local site talks to the same Supabase project, so test data you submit is real data — delete or archive it afterwards.

## 6. Browser support

Latest Chrome, Edge, Safari (iOS 16+) and Samsung Internet. Photos are compressed on the phone before upload (max 1600 px, JPEG, ~300 KB). PDF export and archiving are intended for a desktop browser; they also work on recent phones for small ranges.

## 7. Libraries (all free / MIT or Apache)

supabase-js 2.117.2 · Quill 2.0.3 · DOMPurify 3.2.6 · browser-image-compression 2.0.2 · html2canvas 1.4.1 · jsPDF 2.5.2 · SheetJS CE 0.20.3 · JSZip 3.10.1 · FileSaver 2.0.5 · Inter & Noto Naskh Arabic (SIL OFL, self-hosted). No analytics or trackers.
