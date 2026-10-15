# job-trackwsp

A personal tracker for Summer 2027 internship applications. Single user (Moshi,
CS student at Queen's, systems/C background). **Tauri desktop app** — not a
hosted web app, no auth, no multi-user concerns.

## Pipeline

1. Two scheduled Claude tasks (daily + weekly) search for postings and POST them
   to a Google Apps Script endpoint.
2. That endpoint upserts into a Google Sheet, the "discovery inbox", deduplicated
   by `job_key`.
3. This app syncs the sheet into a local SQLite database, parses job-related
   Gmail with an LLM, and shows everything in a desktop UI.

## Layout

```
apps-script/code.gs    the inbox endpoint (deployed in Google, copy kept here)
scheduler/daily.md     prompt for the daily scheduled task ({URL}/{TOKEN} placeholders)
scheduler/weekly.md    prompt for the weekly deep sweep
frontend/              Vite + React 19 + TS + Tailwind v4
src-tauri/             Rust core
```

## Stack

- **Frontend**: Vite, React 19, TypeScript, Tailwind v4 (CSS-first `@theme`, no
  `tailwind.config.js`), Oxlint. Fonts via `@fontsource`.
- **Core**: Rust, Tauri v2, SQLx + SQLite, `reqwest` + `serde` for HTTP,
  `oauth2` for the Gmail loopback flow.
- The frontend calls Rust through Tauri commands (`invoke`). There is no HTTP
  server and no REST API.

## Identity and deduplication (important)

The same posting can be found several times with slightly different data. Three
layers of matching, and they must stay identical between `apps-script/code.gs`
and the Rust core:

- `norm(s)`: lowercase, every run of non-alphanumerics becomes one space, trim.
- `job_key`: `company|req_id` when there's a req id, else `company|title|city`,
  each part normalized.
- Fallbacks, in order: `job_key`, then `company|title|city` ("triple"), then the
  URL with query/fragment/trailing slash stripped.

A posting that gains a req id later must **update the existing row's key**, not
insert a new row.

## Data model

- `jobs` — mirrors the sheet. Owned by the sync. `hidden` lets the user dismiss
  a posting without the sync resurrecting it.
- `applications` — the user's applications. **Never** written by the sync.
  `job_id` is nullable, since the user can apply to things the scheduler never
  found. `status` is stored and recomputed whenever an event is written.
- `emails` — raw Gmail messages, unique on `gmail_id`.
- `extractions` — what the LLM pulled from an email, awaiting confirmation.
  Nothing changes an application until the user confirms.
- `application_events` — the per-application timeline; the latest event
  determines `applications.status`.

Timestamps are ISO-8601 text (`YYYY-MM-DD` for sheet dates, full
`YYYY-MM-DDTHH:MM:SSZ` for anything the app records). SQLite has no date type
and text sorts correctly.

## Sheet quirks

- Apps Script intermittently returns an HTML error page instead of JSON, even
  though the script ran. **Always retry** a non-JSON response up to 3 times with
  a 10s wait. Writes are idempotent, so retrying a POST is safe.
- Every cell comes back as a string, booleans included: `"true"` / `"false"`.
- The endpoint takes `?token=` on GET and `{"token": ...}` in the POST body.
  Both live in the env as `URL` and `TOKEN` (matches `.env.example` and the
  `{URL}`/`{TOKEN}` placeholders in `scheduler/*.md`).

## Design

The UI mirrors the user's portfolio (aakwsp.xyz, repo `aakwsp/aaq-portfolio`) —
"terminal monastic": editorial serif headings over monospace metadata, all
lowercase, hairline dividers, zero border radius anywhere, no shadows.

- Tokens live in `frontend/src/index.css`. Do not invent colors; use the
  variables.
- `--bg #141216`, `--text #d8cab8`, `--text-muted #8a7e8e`, `--rule #211e26`.
- DM Serif Display for headings, Space Mono for everything else.
- Status shows as a 3px left edge on a row: pink = closing soon, blue =
  borderline, green = applied, red (`--status-overdue`) = past due and not
  applied.
- Section headers read `// toronto, on` in 10px uppercase mono, with a muted
  count on the right.
- The list must stay **dense**: there are 230+ postings, so rows, not cards.
  Cards are only for a short "closing soon" strip.

## Conventions

- Secrets live in `.env` (gitignored). `.env.example` lists the keys with empty
  values. Never commit a token; never paste one into `scheduler/*.md`, which
  keep `{URL}` / `{TOKEN}` placeholders.
- Branches are named `moshi/jt-<n>`; commits start with `JT-<n>:`. Work is
  tracked in Linear (team key `JT`).
- The user is learning frontend — explain non-obvious React and CSS choices
  briefly in comments or in the reply, rather than silently doing the clever
  thing.

## Running locally

- `npm run dev` / `npm run build` from the **repo root** (not `frontend/`) —
  the Tauri CLI needs a cwd containing `src-tauri/`, so `npm --prefix frontend
  run tauri dev` doesn't work.
- On this machine (Wayland + WebKitGTK) two env vars are required, already set
  in the root `dev` script:
  - `GDK_BACKEND=x11` — without it, `Error 71 (Protocol error) dispatching to
    Wayland display`.
  - `WEBKIT_DISABLE_DMABUF_RENDERER=1` — without it, the window opens blank
    with `Failed to create GBM`.
