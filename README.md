# WBG Weekly Activity Tracking (v3, stage 1b)

Weekly plans, progress, Ethiopian-calendar monthly reports and an activity log for Wagwago Business Group's functions and business units.
Vite + vanilla JS front end; data is stored in a free Supabase (Postgres) project.

## 1. Create the Supabase project
1. Sign in at https://supabase.com and click **New project** (the free plan is fine). Pick a name, a database password and a region.
2. When it is ready, open **Project Settings > API** and copy the **Project URL** and the **anon public** key.

## 2. Create the tables
1. In Supabase open **SQL Editor > New query**.
2. Paste the whole of `supabase/schema.sql` and press **Run**. (Safe to run again.)
3. Optional but recommended: paste `supabase/seed.sql` and run it. It loads the 12 units, the 14 weekly plans (222 tasks) and the activity log exported from the Claude artifact. Re-running it never overwrites existing rows.

## 3. Set your keys
```bash
cp .env.example .env
```
Edit `.env`:
```
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# leave both empty to run in local test mode
```
`.env` is git-ignored. Never commit it. (The anon key is designed to be public, but see "Security" below.)

## 4. Run locally
```bash
npm install
npm run dev
```
Open the address Vite prints (usually http://localhost:5173). To check a production build: `npm run build && npm run preview`.

## 5. Deploy
Both hosts: connect the Git repository, then set the `VITE_` variables in the host's settings **before** building. Vite bakes them in at build time, so changing them means redeploying.

- **Vercel:** New Project > import the repo. Framework preset: Vite. Build command `npm run build`, output directory `dist`. Add the environment variables, then Deploy.
- **Netlify:** Add new site > import the repo. Build command `npm run build`, publish directory `dist`. Add the environment variables under Site configuration, then Deploy.

## What is new in stage 1b
- **Dark mode** is now neutral black with a richer golden yellow. Light mode is unchanged.
- **One Dashboard.** Overview is merged into the Dashboard: KPIs and trend on top, then the unit table, blockers and asks, and the task list. There is no separate Overview tab.
- **Approvals** moved behind the bell icon at the top right (it shows how many changes are waiting). A later stage replaces it with notifications that open the task.
- **Starting data** (`supabase/seed.sql`, and the local test data) is rebuilt from the 10 Oct 2026 export. Plans saved for Monday 12 Oct are in the week of Sat 10 Oct; Niyat's later plans are in the weeks of 17 Oct, 24 Oct and 31 Oct.

### Loading the new seed into the TEST project
Run in the SQL Editor, in this order: `truncate activity, plans, units;` then the whole of `supabase/seed.sql`. (The truncate removes the old Monday-dated rows so nothing is duplicated; test project only.) Business support, feedback and corrective actions are not touched.

## What is new in version 3 (stage 1)
- **This week's update** columns are now: Task, Type, Department, Due, Priority, Status update, %, Note, Evidence, Owner. Dependencies go in the Note.
- **Average % complete counts every task.** Done = 100, otherwise the % entered; a task with no status or no % counts as 0. A progress bar for the whole week's plan sits at the top, and each unit has its own bar.
- **Click a column title to sort** (Priority sorts High, Medium, Low; empty values go last). Click again for the reverse, a third time to clear.
- **Weeks run Saturday to Friday** from Saturday 10 Oct 2026. Earlier weeks keep their Monday dates. `upgrade-4` moves any plan saved for "Monday 12 Oct" to the week of 10 Oct.
- **Business support** tab: log and follow up requests made to a corporate function (starts with the HR support log). Active requests are shown by default, 15 at a time, with filters for status, function, requester, category, dates and search, and Excel / PDF downloads.
- **Feedback** tab: feedback from the CEO, DCEO or Group Strategy per unit (a unit acknowledges it), and a **corrective action log** (Group Strategy or the unit logs an action; only Group Strategy closes it).
- Stage 2 (not in this version): sign-in with company email, roles and row-level security. Unit PINs and the approver code still apply.

## Upgrading to v3 stage 1 (test project first)
1. **SQL Editor:** run `supabase/upgrade-4-v3-stage1.sql` (after `schema.sql` and `upgrade-1-safe.sql`). Safe to run again.
2. Optional starting data: `supabase/seed.sql` (plans and activity, with the 12 Oct plans already moved to 10 Oct) and `supabase/seed-support.sql` (24 HR support requests).
3. Deploy the new site files (on a branch first). The new tabs show empty lists until step 1 is done.

## Who can change what (v2)
There is still no email sign-in. Instead:

- **Anyone with the link can view.** To change a plan, a person signs in with their **name, their unit, and the unit's PIN**. Group Strategy sets each unit's PIN in the **Units** tab. The PIN is checked by the database on every save, so a made-up name cannot change anything.
- **Group Strategy approvers** are people whose name starts with or contains `Surafel`, `Surafel Hailu`, `Ataklti` or `Ataklti Nega` **and** who enter the approver code. A name alone is not enough, because anyone can type a name. The name list is in the Supabase table `app_config` (key `approver_names`).
- **Saved tasks keep their definition.** Once a week has started, a saved task's title, expected outcome, type, department, due date and priority are fixed (🔒). Units update status, %, notes, owner, dependencies and evidence freely. To change a fixed field they press **Request change**; removing a saved task also becomes a request. Next week's plan stays fully editable until that week starts.
- **Past weeks need approval.** Any change to a week that has ended is sent to the **Approvals** tab and is recorded only when an approver accepts it. Approvers can edit everything directly.
- PINs and the approver code are stored as bcrypt hashes. 20 wrong tries in 15 minutes locks that unit (or approvals) for 15 minutes.

## Backups, history and undo
- **Every change keeps a copy automatically** (database trigger, table `row_history`). Open a plan and press **History** to see every earlier version; approvers can **Restore** any of them (the version being replaced is kept too, so a restore can be undone).
- After a save, the message at the bottom has **Undo** (works for 30 minutes on your own save).
- **Units tab > Download full backup (JSON)**: a complete offline copy of units, plans, activity and requests. Keep one on the shared drive every week. **Restore from a backup file** puts it back.
- Optional: `supabase/upgrade-3-reminders.sql` also schedules a weekly snapshot.

## Evidence files
Optional on every task: **📎 Attach** up to 3 files at once, 5 MB in total (PDF, images, Word, Excel, PowerPoint, text, CSV). Files go to a private Supabase Storage bucket called `evidence` (free plan: 1 GB). They are linked to the task when the plan is saved.

## Automatic reminders
- **In the app:** each unit sees a Reminders panel when it opens its plan (overdue, due in 2 days, blocked 5+ days, carried 2+ weeks, no status, other units waiting on it, not updated for 3 days, next week's plan missing from Thursday). The **Follow-up** tab and the **Dashboard** escalations list show the same checks for every unit.
- **By Telegram (optional):** `supabase/upgrade-3-reminders.sql` sends each unit's reminders to its Telegram group and a summary to Group Strategy on a schedule (for example Wednesday and Friday 09:00). Setup steps are at the top of that file.

## Upgrading the live site to v2 (order matters)
1. **Supabase > SQL Editor:** run `supabase/upgrade-1-safe.sql`. The current live site keeps working; from now on every save is backed up.
2. In the same file, at the bottom, set the **approver code** (edit the text in quotes, select that line, Run).
3. Test the new version on your computer (see "Versions" below), then push it so Vercel deploys it.
4. On the live site: sign in as Ataklti or Surafel with the approver code, open **Units**, and set a PIN for every unit. Send each unit its PIN privately.
5. Only then run `supabase/upgrade-2-lockdown.sql`. After this, the database refuses any change that does not come through the PIN-checked functions (the old site can no longer save).
6. Optional: `supabase/upgrade-3-reminders.sql` for Telegram reminders.

For a brand-new project: run `schema.sql`, `seed.sql`, then the upgrade files in order.

## Versions: test locally first, keep or drop changes
Your code lives in GitHub; Vercel rebuilds the live site from the `main` branch every time you push to it. So nothing reaches the live site until you push.

**Test safely on localhost.** If `.env` holds the live Supabase keys, `npm run dev` on your computer edits the **real** data. To test without risk either:
- rename `.env` to `.env.off` and run `npm run dev`: the page says **Local test mode** and keeps everything in your browser (approver code `approve`), or
- make a second free Supabase project as a test copy, run the SQL files there, and put its keys in `.env`.

**Typical cycle**
```bash
git checkout -b v2-dashboard      # work on a branch, main stays as the live version
# copy the new files in, then:
npm install && npm run dev        # check it on http://localhost:5173
git status                        # see which files changed
git diff                          # see exactly what changed
git add -A && git commit -m "v2: dashboard, PINs, approvals, evidence, backups"
git push -u origin v2-dashboard   # Vercel builds a Preview link for the branch, live site untouched
```
When the preview is right, merge the branch into `main` on GitHub (Pull request > Merge). That deploys it live. Mark releases so you can find them: `git tag v2.0 && git push --tags`.

**Dropping changes**
- Not committed yet, throw away everything: `git restore .` (and `git clean -fd` for new files).
- One file only: `git restore src/main.js`.
- Committed on a branch you no longer want: `git checkout main && git branch -D v2-dashboard`.
- Already live and something is wrong: in Vercel > Deployments, open the previous good deployment and choose **Promote to Production** (instant rollback). Then fix the code, or undo the commit with `git revert <commit>` and push.

Code rollbacks do not touch the data: plans live in Supabase. For data, use History / Restore or a backup file.

## What was replaced
| In the Claude artifact | Here |
|---|---|
| `claude.use("db")` (collections units, plans, activity, live listeners) | `src/data.js` with `@supabase/supabase-js`; tables in `supabase/schema.sql` |
| `claude.use("user")` (signed-in id, display names, owner flag) | Name box + optional admin code (`src/data.js`, `showWho` in `src/main.js`) |
| `claude.use("downloads")` | Normal browser file download |
| jsPDF / SheetJS from a CDN | Installed from npm and bundled |
| Last unit picked (`localStorage`) | Unchanged |

Per-person sign-in is replaced by unit PINs and an approver code (see "Who can change what").

## Project layout
```
index.html            page markup
src/main.js           the app
src/data.js           Supabase data layer (reads, PIN-checked writes, evidence storage) and local test mode
src/rules.js          what a unit may change directly vs. what needs approval (same rules as the database)
src/alerts.js         automatic reminders and blocker checks
src/dashboard.js      executive dashboard charts
src/style.css         styles
supabase/schema.sql   tables, indexes, Row Level Security, realtime
supabase/seed.sql     starting data
supabase/upgrade-1-safe.sql      v2 tables and functions (safe with the old site)
supabase/upgrade-2-lockdown.sql  v2 lockdown (run after the new site is live)
supabase/upgrade-3-reminders.sql optional Telegram reminders and weekly snapshot
supabase/upgrade-4-v3-stage1.sql v3: Saturday weeks, Business support, Feedback, Corrective actions
supabase/seed.sql, seed-support.sql starting data
.env.example
```
